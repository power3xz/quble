// resume 해석기 - SSR이 그린 DOM에 바이트코드의 구멍(값 텍스트, 동적 속성, 이벤트, region)만 연결한다.
//
// 노드를 새로 만들지 않는다. 바이트코드가 요구하는 순서로 SSR DOM의 노드를 앞순회로 꺼내 쓰고, 안에 구멍이
// 없는 정적 서브트리(static-spans.ts)는 요소 하나만 받고 자손을 방문하지 않는다. 첫 그리기만 이 해석기가
// 한다. 그 뒤의 lazy build(꺼진 @if 가지가 켜질 때)와 @for grow는 vm.ts의 VM이 한다 -
// 바인딩과 이벤트 위임도 그 인스턴스의 것을 불러, 이 해석기가 건 것과 이후 건 것이 한 곳에 모인다.

import { TAGS } from "./dom-tables.ts";
import {
  OP_ATTR_G,
  OP_ATTR_G_EXPR,
  OP_ATTR_G_VAR,
  OP_ATTR_L,
  OP_ATTR_L_EXPR,
  OP_ATTR_L_VAR,
  OP_BIND_EVENT,
  OP_ELEM_CLOSE_OPEN,
  OP_ELEM_END,
  OP_ELEM_OPEN,
  OP_ENTER_CONTEXT,
  OP_EXIT_CONTEXT,
  OP_FILL_SLOT_PLACEHOLDER,
  OP_FOR_ARRAY_VAR,
  OP_FOR_COUNT_VAR,
  OP_FOR_RAW,
  OP_HALT,
  OP_IF,
  OP_IF_EXPR,
  OP_LOAD_RES,
  OP_PUSH_ARG_LIT,
  OP_PUSH_FIELD,
  OP_PUSH_PATH_INDEX_SEGMENT,
  OP_PUSH_PATH_SEGMENT,
  OP_PUSH_SLOT_PLACEHOLDER_CONTENT,
  OP_PUSH_THROUGH,
  OP_RENDER,
  OP_TEXT,
  OP_TEXT_EXPR,
  OP_TEXT_VAR,
  operandLen,
} from "./opcodes.ts";
import {
  activateIf,
  appendBranchOfForRegion,
  appendForRegion,
  appendIfRegion,
  attachGrownIterations,
  ELSE_INDEX,
  type TBranch,
  THEN_INDEX,
  truncateFor,
} from "./region.ts";
import { staticElementEnds } from "./static-spans.ts";
import { STORE, type VM } from "./vm.ts";

// vm.ts의 같은 이름 도우미와 타입의 사본이다. 공통부를 뽑을 때 합친다.
const CONST = 1;
const RAW = 2;
type TScope = readonly number[];
const slotKind = (scope: TScope, o: number): number => scope[2 * o];
const slotRef = (scope: TScope, o: number): number => scope[2 * o + 1];
const scopeWithIteration = (
  scope: TScope,
  itemKind: number,
  itemRef: number,
  indexKind: number,
  indexRef: number,
): TScope => scope.concat([itemKind, itemRef, indexKind, indexRef]);
type TWalkStacks = {
  loopIndexStack: number[];
  activeContexts: number[];
};
const snapshotStacks = (walkStacks: TWalkStacks): TWalkStacks => ({
  loopIndexStack: [...walkStacks.loopIndexStack],
  activeContexts: [...walkStacks.activeContexts],
});
// 사용쪽이 RENDER 앞에 깔아둔 슬롯 콘텐츠 한 덩이. 코드 구간은 부모 def 안에 있고 해석 컨텍스트도 부모 것을 든다.
type TSlotPlaceholderContent = {
  startPc: number;
  endPc: number;
  argumentSourcePairs: TScope;
  compId: number;
  pathPrefix: string;
  loopIndexBase: number;
  walkStacks: TWalkStacks;
  branchIndex: number;
};

// SSR이 텍스트 경계를 주석으로 남긴다(crates/renderer).
//   <!---->          이웃한 두 텍스트 노드 사이의 경계 - 지운다
//   <!--qb:empty-->  값이 빈 텍스트 노드 자리 - 빈 텍스트 노드로 바꾼다(resume이 새로 만드는 유일한 노드)
const TEXT_BOUNDARY_MARK = "";
const EMPTY_TEXT_MARK = "qb:empty";
const REGION_ANCHOR_PREFIX = "qb:region#";

// SSR 페이지가 head에 이미 넣은 리소스 - <link href>, 또는 인라인한 <style data-qb-href>. 속성은 상대 경로일
// 수 있어 둘 다 문서 주소 기준으로 푼 값끼리 견준다. about:blank 문서처럼 풀 기준이 없으면 문자열 그대로 견준다.
const resolveHref = (href: string): string => {
  try {
    return new URL(href, document.baseURI).href;
  } catch {
    return href;
  }
};

const inHead = (url: string): boolean => {
  const resolved = resolveHref(url);
  return [...document.head.querySelectorAll("link, style[data-qb-href]")].some(
    (el) => resolveHref(el.getAttribute("href") ?? el.getAttribute("data-qb-href") ?? "") === resolved,
  );
};

export class ResumeInterpreter {
  code: Uint8Array;
  staticEnds: Map<number, number>;

  // 다음에 내줄 SSR 노드. 다 내줬으면 null.
  upcoming: Node | null;
  // 안으로 들어간 요소들의 다음 형제. 내준 노드를 가지가 옮길 수 있어(nextSibling이 사라진다) 내주기 전에 잡아
  // 둔다. 자식(firstChild)은 노드를 옮겨도 그대로다.
  after: (Node | null)[] = [];

  constructor(code: Uint8Array, root: Node) {
    this.code = code;
    this.staticEnds = staticElementEnds(code, 0, code.length);
    this.upcoming = root.firstChild;
  }

  // ── SSR 노드 꺼내기 ───────────────────────────────────────────────

  // 앞순회로 한 노드를 내준다. descend가 false면 자손을 방문하지 않고 다음 형제로 간다(정적 서브트리).
  next = (descend = true): Node => {
    const node = this.upcoming;
    if (node === null) {
      throw new Error("resume: SSR 노드가 모자란다");
    }
    const sibling = node.nextSibling;
    if (descend && node.firstChild !== null) {
      this.after.push(sibling);
      this.upcoming = node.firstChild;
    } else {
      this.upcoming = sibling ?? this.climb();
    }
    return node;
  };

  // 조상들의 다음 형제 중 가장 안쪽의 null이 아닌 것. 없으면 순회 끝이다.
  climb = (): Node | null => {
    while (this.after.length > 0) {
      const sibling = this.after.pop() as Node | null;
      if (sibling !== null) {
        return sibling;
      }
    }
    return null;
  };

  mismatch = (want: string, got: Node): Error =>
    new Error(`resume: ${want}를 기대했는데 ${got.nodeName}(${got.textContent?.slice(0, 20) ?? ""})를 만났다`);

  element = (tag: string, descend = true): HTMLElement => {
    const node = this.next(descend);
    if (node.nodeType === node.ELEMENT_NODE && (node as Element).localName === tag) {
      return node as HTMLElement;
    }
    throw this.mismatch(`<${tag}>`, node);
  };

  text = (): Text => {
    for (;;) {
      const node = this.next();
      if (node.nodeType === node.TEXT_NODE) {
        return node as Text;
      }
      if (node.nodeType === node.COMMENT_NODE && (node as Comment).data === TEXT_BOUNDARY_MARK) {
        (node as Comment).remove();
        continue;
      }
      if (node.nodeType === node.COMMENT_NODE && (node as Comment).data === EMPTY_TEXT_MARK) {
        const empty = document.createTextNode("");
        (node as Comment).replaceWith(empty);
        return empty;
      }
      throw this.mismatch("텍스트", node);
    }
  };

  anchor = (): Comment => {
    const node = this.next();
    if (node.nodeType === node.COMMENT_NODE && (node as Comment).data.startsWith(REGION_ANCHOR_PREFIX)) {
      return node as Comment;
    }
    throw this.mismatch("region 앵커", node);
  };

  // 다 꺼냈는지 - 남았으면 SSR과 런타임이 다른 것을 그렸다.
  finish = (): void => {
    const left = this.upcoming ?? this.climb();
    if (left !== null) {
      throw new Error(`resume: 짚지 않은 SSR 노드가 남았다(${left.nodeName})`);
    }
  };

  // LOAD_RES. SSR 페이지가 head에 이미 넣었으면 <link>를 또 넣지 않는다.
  loadResource = (vm: VM, resId: number) => {
    const url = vm.resources[resId];
    if (url && !vm.loadedHrefs.has(url)) {
      vm.loadedHrefs.add(url);
      if (inHead(url)) {
        return;
      }
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = url;
      document.head.appendChild(link);
    }
  };

  // ── 바이트코드 해석 ───────────────────────────────────────────────

  // startPc~endPc를 SSR 노드에 연결하고, 이 범위의 최상위 노드(앵커 포함)를 낸다. 최상위 노드는 가지가
  // branch.nodes로 들고 있다가 떼고 붙인다. 요소 안의 노드는 제자리에 있어 따로 모으지 않는다.
  interpret = (
    vm: VM,
    argumentSourcePairs: TScope,
    compId: number,
    startPc: number,
    endPc: number,
    startBranchIndex: number,
    pathPrefix: string,
    loopIndexBase: number,
    walkStacks: TWalkStacks,
    slotPlaceholderContents: (TSlotPlaceholderContent | undefined)[] = [],
  ): { childNodes: ChildNode[] } => {
    const code = this.code;
    const tops: ChildNode[] = [];
    let depth = 0; // 열린 요소 수. 0이면 지금 꺼내는 노드가 최상위다.
    let pending: HTMLElement | null = null;
    let args = [];
    let segment: string | null = null; // 다음 RENDER/BIND_EVENT가 소비할 경로 세그먼트
    let pendingSlotPlaceholderContents: (TSlotPlaceholderContent | undefined)[] = [];
    let pc = startPc;
    const branch = vm.branchPool.entries[startBranchIndex];

    const u16at = () => {
      const v = code[pc] | (code[pc + 1] << 8);
      pc += 2;
      return v;
    };
    const u8at = () => code[pc++];
    const addTop = (node: ChildNode) => {
      if (depth === 0) {
        tops.push(node);
      }
    };
    const addTops = (nodes: ChildNode[]) => {
      if (depth === 0) {
        for (const node of nodes) {
          tops.push(node);
        }
      }
    };
    const topsIfTop = () => (depth === 0 ? tops : null);

    while (pc < endPc) {
      const op = code[pc++];
      switch (op) {
        case OP_HALT: {
          pc = endPc;
          break;
        }
        case OP_LOAD_RES: {
          this.loadResource(vm, u16at());
          break;
        }
        case OP_ELEM_OPEN: {
          const openPc = pc - 1;
          const tag = TAGS[u16at()];
          const staticEnd = this.staticEnds.get(openPc);
          if (staticEnd !== undefined) {
            // 구멍이 없는 서브트리 - 요소 하나만 받고 속성, 자식, 닫는 op를 모두 건너뛴다.
            addTop(this.element(tag, false));
            pc = staticEnd;
          } else {
            pending = this.element(tag);
          }
          break;
        }
        case OP_ATTR_G:
        case OP_ATTR_L: {
          pc += operandLen(op); // 정적 속성은 SSR HTML에 이미 있다
          break;
        }
        case OP_ATTR_G_VAR:
        case OP_ATTR_L_VAR:
        case OP_ATTR_G_EXPR:
        case OP_ATTR_L_EXPR: {
          vm.bindValueSlot(op, pc, pending as HTMLElement, compId, argumentSourcePairs, branch);
          pc += operandLen(op);
          break;
        }
        case OP_BIND_EVENT: {
          const domEventIndex = u16at();
          const eventIndex = u16at();
          vm.bindEvent(
            pending as HTMLElement,
            domEventIndex,
            eventIndex,
            segment,
            compId,
            pathPrefix,
            argumentSourcePairs,
            walkStacks,
          );
          segment = null;
          break;
        }
        case OP_ELEM_CLOSE_OPEN: {
          addTop(pending as HTMLElement);
          depth += 1;
          pending = null;
          break;
        }
        case OP_TEXT: {
          pc += operandLen(op); // 정적 텍스트는 SSR HTML에 이미 있다
          addTop(this.text());
          break;
        }
        case OP_TEXT_VAR:
        case OP_TEXT_EXPR: {
          const node = this.text();
          vm.bindValueSlot(op, pc, node, compId, argumentSourcePairs, branch);
          pc += operandLen(op);
          addTop(node);
          break;
        }
        case OP_ELEM_END: {
          depth -= 1;
          break;
        }
        case OP_PUSH_THROUGH: {
          const scopeIndex = u8at();
          args.push(slotKind(argumentSourcePairs, scopeIndex), slotRef(argumentSourcePairs, scopeIndex));
          break;
        }
        case OP_PUSH_FIELD: {
          const scopeIndex = u8at();
          const offset = u8at();
          args.push(slotKind(argumentSourcePairs, scopeIndex), slotRef(argumentSourcePairs, scopeIndex) + offset);
          break;
        }
        case OP_PUSH_ARG_LIT: {
          args.push(CONST, u16at());
          break;
        }
        case OP_PUSH_PATH_SEGMENT: {
          segment = vm.module.constpool[u16at()] as string;
          break;
        }
        case OP_PUSH_PATH_INDEX_SEGMENT: {
          const token = `[$${loopIndexBase + u16at()}]`;
          segment = (segment ?? "") + token;
          break;
        }
        case OP_ENTER_CONTEXT: {
          const contextDef = vm.componentContexts(compId)[u16at()];
          const name = vm.module.constpool[contextDef.nameConstIndex as number] as string;
          const fields = contextDef.fields.map((field) => vm.toAssembled(compId, field, argumentSourcePairs));
          if (walkStacks.activeContexts.some((i) => vm.createdContexts[i].name === name)) {
            console.warn(`quble: 컨텍스트 '${name}'가 중복 활성화됐습니다(안쪽이 우선).`);
          }
          walkStacks.activeContexts.push(vm.createdContexts.length);
          vm.createdContexts.push({ name, fields });
          break;
        }
        case OP_EXIT_CONTEXT: {
          walkStacks.activeContexts.pop();
          break;
        }
        case OP_PUSH_SLOT_PLACEHOLDER_CONTENT: {
          const slotPlaceholderIndex = u16at();
          const contentStart = pc;
          const contentEndPc = vm.cachedSlotContentEnd(contentStart);
          pendingSlotPlaceholderContents[slotPlaceholderIndex] = {
            startPc: contentStart,
            endPc: contentEndPc,
            argumentSourcePairs,
            compId,
            pathPrefix,
            loopIndexBase,
            walkStacks: snapshotStacks(walkStacks),
            branchIndex: startBranchIndex,
          };
          pc = contentEndPc + 1;
          break;
        }
        case OP_FILL_SLOT_PLACEHOLDER: {
          const content = slotPlaceholderContents[u16at()];
          if (content === undefined) {
            break;
          }
          addTops(
            this.interpret(
              vm,
              content.argumentSourcePairs,
              content.compId,
              content.startPc,
              content.endPc,
              content.branchIndex,
              content.pathPrefix,
              content.loopIndexBase,
              content.walkStacks,
            ).childNodes,
          );
          break;
        }
        case OP_RENDER: {
          const childCompId = u16at();
          const childArgumentSourcePairs = args;
          args = [];
          const childSlotPlaceholderContents = pendingSlotPlaceholderContents;
          pendingSlotPlaceholderContents = [];
          const childPrefix = pathPrefix ? `${pathPrefix}.${segment}` : segment;
          segment = null;
          const childDef = vm.module.defs[childCompId];
          addTops(
            this.interpret(
              vm,
              childArgumentSourcePairs,
              childCompId,
              childDef.codeOff,
              childDef.codeOff + childDef.codeLen,
              startBranchIndex,
              // biome-ignore lint/style/noNonNullAssertion: RENDER 지점엔 PUSH_PATH_SEGMENT가 깐 segment가 있어 childPrefix는 non-null(바이트코드 순서 보장)
              childPrefix!,
              walkStacks.loopIndexStack.length / 2,
              walkStacks,
              childSlotPlaceholderContents,
            ).childNodes,
          );
          break;
        }
        case OP_IF: {
          pc = this.runIf(
            vm,
            pc,
            argumentSourcePairs,
            compId,
            pathPrefix,
            loopIndexBase,
            walkStacks,
            branch,
            topsIfTop(),
          );
          break;
        }
        case OP_IF_EXPR: {
          pc = this.runIfExpr(
            vm,
            pc,
            argumentSourcePairs,
            compId,
            pathPrefix,
            loopIndexBase,
            walkStacks,
            branch,
            topsIfTop(),
          );
          break;
        }
        case OP_FOR_RAW: {
          const count = Number(u16at()) || 0;
          const bodyStart = pc;
          const forEndPc = vm.cachedForEnd(bodyStart);
          this.inlineFor(
            vm,
            count,
            bodyStart,
            forEndPc,
            topsIfTop(),
            startBranchIndex,
            argumentSourcePairs,
            compId,
            pathPrefix,
            loopIndexBase,
            walkStacks,
          );
          pc = forEndPc + 1;
          break;
        }
        case OP_FOR_COUNT_VAR: {
          const scopeIndex = u8at();
          const offset = u8at();
          const ref = slotRef(argumentSourcePairs, scopeIndex);
          const kind = slotKind(argumentSourcePairs, scopeIndex);
          const bodyStart = pc;
          const forEndPc = vm.cachedForEnd(bodyStart);
          if (kind === CONST || kind === RAW) {
            this.inlineFor(
              vm,
              kind === RAW ? ref : Number(vm.module.constpool[ref]) || 0,
              bodyStart,
              forEndPc,
              topsIfTop(),
              startBranchIndex,
              argumentSourcePairs,
              compId,
              pathPrefix,
              loopIndexBase,
              walkStacks,
            );
          } else {
            this.reactiveCountFor(
              vm,
              ref + offset,
              bodyStart,
              forEndPc,
              topsIfTop(),
              branch,
              argumentSourcePairs,
              compId,
              pathPrefix,
              loopIndexBase,
              walkStacks,
            );
          }
          pc = forEndPc + 1;
          break;
        }
        case OP_FOR_ARRAY_VAR: {
          const scopeIndex = u8at();
          const offset = u8at();
          const arrayLeafIndex = slotRef(argumentSourcePairs, scopeIndex) + offset;
          const bodyStart = pc;
          const forEndPc = vm.cachedForEnd(bodyStart);
          this.reactiveArrayFor(
            vm,
            arrayLeafIndex,
            bodyStart,
            forEndPc,
            topsIfTop(),
            branch,
            argumentSourcePairs,
            compId,
            pathPrefix,
            loopIndexBase,
            walkStacks,
          );
          pc = forEndPc + 1;
          break;
        }
        default: {
          throw new Error(`bad opcode 0x${op.toString(16)}`);
        }
      }
    }
    return { childNodes: tops };
  };

  // @for 회차 i의 몸체를 SSR 노드에 연결한다. 회차 인덱스를 공유 스택에 push -> 재귀 -> pop한다.
  buildIteration = (
    vm: VM,
    indexKind: number,
    indexRef: number,
    bodyStart: number,
    forEndPc: number,
    targetBranchIndex: number,
    argumentSourcePairs: TScope,
    compId: number,
    pathPrefix: string,
    loopIndexBase: number,
    walkStacks: TWalkStacks,
  ): { childNodes: ChildNode[] } => {
    walkStacks.loopIndexStack.push(indexKind, indexRef);
    const nodes = this.interpret(
      vm,
      argumentSourcePairs,
      compId,
      bodyStart,
      forEndPc,
      targetBranchIndex,
      pathPrefix,
      loopIndexBase,
      walkStacks,
    );
    walkStacks.loopIndexStack.pop();
    walkStacks.loopIndexStack.pop();
    return nodes;
  };

  // 안 변하는 @for - 각 회차를 지금 가지에 인라인한다. 회차 노드는 부모의 최상위(tops)로 모은다.
  inlineFor = (
    vm: VM,
    count: number,
    bodyStart: number,
    forEndPc: number,
    tops: ChildNode[] | null,
    startBranchIndex: number,
    argumentSourcePairs: TScope,
    compId: number,
    pathPrefix: string,
    loopIndexBase: number,
    walkStacks: TWalkStacks,
  ) => {
    for (let i = 0; i < count; i++) {
      const nodes = this.buildIteration(
        vm,
        RAW,
        i,
        bodyStart,
        forEndPc,
        startBranchIndex,
        scopeWithIteration(argumentSourcePairs, RAW, i, RAW, i),
        compId,
        pathPrefix,
        loopIndexBase,
        walkStacks,
      );
      if (tops !== null) {
        for (const node of nodes.childNodes) {
          tops.push(node);
        }
      }
    }
  };

  // 숫자 count 반응 @for. region과 처음 회차는 SSR 노드에 연결하고, count가 늘 때의 회차는 VM이 노드를 만든다.
  reactiveCountFor = (
    vm: VM,
    countLeafIndex: number,
    bodyStart: number,
    forEndPc: number,
    tops: ChildNode[] | null,
    branch: TBranch,
    argumentSourcePairs: TScope,
    compId: number,
    pathPrefix: string,
    loopIndexBase: number,
    walkStacks: TWalkStacks,
  ) => {
    const forRegionIndex = appendForRegion(vm.regionPool, countLeafIndex, this.anchor());
    const region = vm.regionPool.entries[forRegionIndex];
    branch.childRegionIndices.push(forRegionIndex);
    tops?.push(region.anchor);

    const stacks = snapshotStacks(walkStacks);

    // 처음 회차는 SSR 노드에서 연결한다.
    const resumeIteration = (i: number) => {
      const newBranchIndex = appendBranchOfForRegion(vm.regionPool, vm.branchPool, forRegionIndex);
      vm.branchPool.entries[newBranchIndex].nodes = this.buildIteration(
        vm,
        RAW,
        i,
        bodyStart,
        forEndPc,
        newBranchIndex,
        scopeWithIteration(argumentSourcePairs, RAW, i, RAW, i),
        compId,
        pathPrefix,
        loopIndexBase,
        stacks,
      ).childNodes;
    };
    // count가 늘 때의 회차는 노드를 새로 짓는다.
    const growIteration = (i: number) => {
      const newBranchIndex = appendBranchOfForRegion(vm.regionPool, vm.branchPool, forRegionIndex);
      vm.branchPool.entries[newBranchIndex].nodes = Array.from(
        vm.buildIteration(
          RAW,
          i,
          bodyStart,
          forEndPc,
          newBranchIndex,
          scopeWithIteration(argumentSourcePairs, RAW, i, RAW, i),
          compId,
          pathPrefix,
          loopIndexBase,
          stacks,
        ).childNodes,
      );
    };

    const initial = Number(vm.store.get(countLeafIndex)) || 0;
    for (let i = 0; i < initial; i++) {
      resumeIteration(i);
    }

    const onCount = (v: unknown) => {
      const next = Number(v) || 0;
      const cur = region.branchIndices.length;
      for (let i = cur; i < next; i++) {
        growIteration(i);
      }
      if (next > cur) {
        attachGrownIterations(vm.store, vm.regionPool, vm.branchPool, forRegionIndex, cur);
      }
      if (next < cur) {
        truncateFor(vm.store, vm.regionPool, vm.branchPool, forRegionIndex, next);
      }
    };
    branch.leafIndices.push(countLeafIndex);
    branch.updateFns.push(onCount);
    vm.store.subscribe(countLeafIndex, onCount);
  };

  // 배열 반응 @for - reactiveCountFor와 같은 구조에서 회차변수 slot이 그 요소 leaf에 붙는다.
  reactiveArrayFor = (
    vm: VM,
    arrayLeafIndex: number,
    bodyStart: number,
    forEndPc: number,
    tops: ChildNode[] | null,
    branch: TBranch,
    argumentSourcePairs: TScope,
    compId: number,
    pathPrefix: string,
    loopIndexBase: number,
    walkStacks: TWalkStacks,
  ) => {
    const info = vm.arrayPool.entries[Number(vm.store.get(arrayLeafIndex))];
    if (info.sizeLeafIndex === null) {
      info.sizeLeafIndex = vm.store.alloc([info.elemStartLeafIndices.length]);
    }
    const sizeLeafIndex = info.sizeLeafIndex;
    if (info.indexLeafIndices.length === 0) {
      for (let i = 0; i < info.elemStartLeafIndices.length; i++) {
        info.indexLeafIndices[i] = vm.store.alloc([i]);
      }
    }

    const forRegionIndex = appendForRegion(vm.regionPool, sizeLeafIndex, this.anchor());
    info.forRegionIndices.push(forRegionIndex);
    const region = vm.regionPool.entries[forRegionIndex];
    branch.childRegionIndices.push(forRegionIndex);
    tops?.push(region.anchor);

    const stacks = snapshotStacks(walkStacks);

    const resumeIteration = (i: number) => {
      const newBranchIndex = appendBranchOfForRegion(vm.regionPool, vm.branchPool, forRegionIndex);
      const indexLeaf = info.indexLeafIndices[i];
      vm.branchPool.entries[newBranchIndex].nodes = this.buildIteration(
        vm,
        STORE,
        indexLeaf,
        bodyStart,
        forEndPc,
        newBranchIndex,
        scopeWithIteration(argumentSourcePairs, STORE, info.elemStartLeafIndices[i], STORE, indexLeaf),
        compId,
        pathPrefix,
        loopIndexBase,
        stacks,
      ).childNodes;
    };
    const growIteration = (i: number) => {
      const newBranchIndex = appendBranchOfForRegion(vm.regionPool, vm.branchPool, forRegionIndex);
      const indexLeaf = info.indexLeafIndices[i];
      vm.branchPool.entries[newBranchIndex].nodes = Array.from(
        vm.buildIteration(
          STORE,
          indexLeaf,
          bodyStart,
          forEndPc,
          newBranchIndex,
          scopeWithIteration(argumentSourcePairs, STORE, info.elemStartLeafIndices[i], STORE, indexLeaf),
          compId,
          pathPrefix,
          loopIndexBase,
          stacks,
        ).childNodes,
      );
    };

    for (let i = 0; i < info.elemStartLeafIndices.length; i++) {
      resumeIteration(i);
    }

    const onSize = () => {
      const next = info.elemStartLeafIndices.length;
      const cur = region.branchIndices.length;
      for (let i = cur; i < next; i++) {
        growIteration(i);
      }
      if (next > cur) {
        attachGrownIterations(vm.store, vm.regionPool, vm.branchPool, forRegionIndex, cur);
      }
      if (next < cur) {
        truncateFor(vm.store, vm.regionPool, vm.branchPool, forRegionIndex, next);
      }
    };
    branch.leafIndices.push(sizeLeafIndex);
    branch.updateFns.push(onSize);
    vm.store.subscribe(sizeLeafIndex, onSize);
  };

  // IF - 조건 슬롯을 그대로 조건 칸으로 쓴다. pc는 IF operand 직후이고 IF_END 다음 pc를 돌려준다.
  runIf = (
    vm: VM,
    pc: number,
    argumentSourcePairs: TScope,
    compId: number,
    pathPrefix: string,
    loopIndexBase: number,
    walkStacks: TWalkStacks,
    branch: TBranch,
    tops: ChildNode[] | null,
  ): number => {
    const condScopeIndex = this.code[pc++];
    const condOffset = this.code[pc++];
    const condIsConst = slotKind(argumentSourcePairs, condScopeIndex) === CONST;
    const condRef = slotRef(argumentSourcePairs, condScopeIndex);
    const condLeafIndex = condIsConst ? -1 : condRef + condOffset;
    return this.buildIfRegion(
      vm,
      pc,
      condLeafIndex,
      condIsConst ? vm.module.constpool[condRef] : vm.store.get(condLeafIndex),
      false,
      argumentSourcePairs,
      compId,
      pathPrefix,
      loopIndexBase,
      walkStacks,
      branch,
      tops,
    );
  };

  // IF_EXPR - 식의 결과를 담을 파생 칸을 잡고, 식이 읽는 칸을 구독해 다시 센다. 그 뒤는 IF와 같다.
  runIfExpr = (
    vm: VM,
    pc: number,
    argumentSourcePairs: TScope,
    compId: number,
    pathPrefix: string,
    loopIndexBase: number,
    walkStacks: TWalkStacks,
    branch: TBranch,
    tops: ChildNode[] | null,
  ): number => {
    const expr = vm.module.defs[compId].exprs[this.code[pc++]];
    const value = vm.subscribeExpr(expr, argumentSourcePairs, branch, (v) => vm.store.set(condLeafIndex, v));
    const condLeafIndex = vm.store.alloc([value]);
    return this.buildIfRegion(
      vm,
      pc,
      condLeafIndex,
      vm.store.get(condLeafIndex),
      true,
      argumentSourcePairs,
      compId,
      pathPrefix,
      loopIndexBase,
      walkStacks,
      branch,
      tops,
    );
  };

  // IF/IF_EXPR 공통 - then/else region을 만들고 지금 보이는 가지만 SSR 노드에 연결한다. 안 보이는 가지는
  // VM으로 build하는 lazyBuild를 심어 둔다(켜질 때 노드를 새로 짓는다).
  buildIfRegion = (
    vm: VM,
    pc: number,
    condLeafIndex: number,
    condInitial: unknown,
    ownsCondLeaf: boolean,
    argumentSourcePairs: TScope,
    compId: number,
    pathPrefix: string,
    loopIndexBase: number,
    walkStacks: TWalkStacks,
    branch: TBranch,
    tops: ChildNode[] | null,
  ): number => {
    const regionIndex = appendIfRegion(vm.regionPool, vm.branchPool, condLeafIndex, ownsCondLeaf, this.anchor());
    const region = vm.regionPool.entries[regionIndex];
    branch.childRegionIndices.push(regionIndex);
    tops?.push(region.anchor);
    const thenBranchIndex = region.branchIndices[THEN_INDEX];
    const elseBranchIndex = region.branchIndices[ELSE_INDEX];
    const thenBranch = vm.branchPool.entries[thenBranchIndex];
    const elseBranch = vm.branchPool.entries[elseBranchIndex];

    const ifBodyStart = pc;
    const { ifBodyEnd, elseBodyStart, ifEndPc } = vm.cachedIfRanges(ifBodyStart);
    const stacks = snapshotStacks(walkStacks);

    // 나중에 켜질 때(첫 활성화)는 VM이 노드를 새로 만든다.
    thenBranch.lazyBuild = () => {
      const f = vm.interpret(
        argumentSourcePairs,
        compId,
        ifBodyStart,
        ifBodyEnd,
        thenBranchIndex,
        pathPrefix,
        loopIndexBase,
        stacks,
      );
      thenBranch.nodes = Array.from(f.childNodes);
    };
    elseBranch.lazyBuild = () => {
      const f =
        elseBodyStart === -1
          ? document.createDocumentFragment()
          : vm.interpret(
              argumentSourcePairs,
              compId,
              elseBodyStart,
              ifEndPc,
              elseBranchIndex,
              pathPrefix,
              loopIndexBase,
              stacks,
            );
      elseBranch.nodes = Array.from(f.childNodes);
    };

    if (condLeafIndex !== -1) {
      const onCond = (condValue: unknown) => {
        activateIf(vm.store, vm.regionPool, vm.branchPool, regionIndex, condValue ? THEN_INDEX : ELSE_INDEX);
      };
      branch.leafIndices.push(condLeafIndex);
      branch.updateFns.push(onCond);
      vm.store.subscribe(condLeafIndex, onCond);
    }

    // 지금 보이는 가지는 SSR 노드에서 연결한다. 보이지 않는 가지는 SSR이 그리지 않았다.
    const initialShownIndex = condInitial ? THEN_INDEX : ELSE_INDEX;
    const initialBranch = vm.branchPool.entries[region.branchIndices[initialShownIndex]];
    if (initialShownIndex === THEN_INDEX) {
      initialBranch.nodes = this.interpret(
        vm,
        argumentSourcePairs,
        compId,
        ifBodyStart,
        ifBodyEnd,
        thenBranchIndex,
        pathPrefix,
        loopIndexBase,
        stacks,
      ).childNodes;
    } else {
      initialBranch.nodes =
        elseBodyStart === -1
          ? []
          : this.interpret(
              vm,
              argumentSourcePairs,
              compId,
              elseBodyStart,
              ifEndPc,
              elseBranchIndex,
              pathPrefix,
              loopIndexBase,
              stacks,
            ).childNodes;
    }
    initialBranch.built = true;
    region.shownIndex = initialShownIndex;

    return ifEndPc + 1;
  };
}
