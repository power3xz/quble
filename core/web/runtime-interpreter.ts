import { ATTRS, TAGS } from "./dom-tables.ts";
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
import type { TBranch } from "./region.ts";
import { STEP_FIRST_CHILD, STEP_NEXT_SIBLING, stepsToEachHole } from "./template-steps.ts";
import {
  CONST,
  RAW,
  STORE,
  scopeWithIteration,
  slotKind,
  slotRef,
  snapshotStacks,
  type TScope,
  type TSlotPlaceholderContent,
  type TTemplatePlan,
  type TWalkStacks,
  type VM,
} from "./vm.ts";

export class RuntimeInterpreter {
  // 안 변하는 @for(FOR_RAW/CONST) - 각 회차를 지금 가지(startRegion/Branch)에 fragment로
  // 인라인한다. @for는 컴포넌트 경계가 아니라 같은 가지의 제어 흐름이라 부모 노드에 통째로
  // 붙인다. appendChild(fragment)는 내용 전체를 한 번에 옮기고 fragment를 비운다(노드별 재입양
  // 대신 1회). 노드 하나씩 옮기면 안 된다: childNodes는 라이브라 순회 중 인덱스가 밀려 건너뛴다.
  inlineFor = (
    vm: VM,
    count: number,
    bodyStart: number,
    forEndPc: number,
    parent: Node,
    startBranchIndex: number,
    argumentSourcePairs: TScope,
    compId: number,
    pathPrefix: string,
    loopIndexBase: number,
    walkStacks: TWalkStacks,
  ) => {
    for (let i = 0; i < count; i++) {
      parent.appendChild(
        vm.buildIteration(
          RAW,
          i,
          bodyStart,
          forEndPc,
          startBranchIndex,
          scopeWithIteration(argumentSourcePairs, RAW, i, RAW, i), // item(회차값)/index 모두 [RAW,i](리터럴은 반응성 없어 상수)
          compId,
          pathPrefix,
          loopIndexBase,
          walkStacks,
        ) as DocumentFragment, // 이 해석기는 늘 fragment를 낸다
      );
    }
  };

  // 숫자 count 반응 @for(FOR_SCOPE_INDEX+STORE, 값이 숫자) - 전용 region을 만들어 회차마다 branch
  // 하나에 노드/구독/자식region을 격리한다(count 줄 때 그 회차만 통째로 떼기 위함). anchor를 지금
  // 가지에 남기고 회차 노드는 anchor 뒤에 붙는다. 초기엔 branch.nodes만 채운다(부모 attachIf가
  // 루트부터 일괄 attach할 때 이 region도 childRegionIndices 재귀로 붙는다 - @if 자식과 동일).
  // count leaf 구독이 꼬리 회차를 늘리고(build+attach) 줄인다(truncate).
  reactiveCountFor = (
    vm: VM,
    countLeafIndex: number,
    bodyStart: number,
    forEndPc: number,
    parent: Node,
    branch: TBranch,
    argumentSourcePairs: TScope,
    compId: number,
    pathPrefix: string,
    loopIndexBase: number,
    walkStacks: TWalkStacks,
  ) => {
    const forRegionIndex = vm.openForRegion(branch, countLeafIndex);
    const region = vm.regionAt(forRegionIndex);
    parent.appendChild(region.anchor);

    // grow(onCount 발화)는 지연 실행이라 그 시점 공유 walkStacks는 이 @for 지점을 지나 이미 pop돼
    // 있다(@if lazyBuild와 동형). build 시점 상태를 딥카피해 addIterationBranch가 캡처한다 - 초기
    // 회차도 같은 스냅샷을 쓴다(build 시점이라 값 동일, push/pop도 스냅샷에만 가 원본 무오염).
    const stacks = snapshotStacks(walkStacks);

    // 회차 branch 하나를 추가하고 build해 담는다(interpret이 fragment로 낸 노드를 detach 때
    // 되찾게 branch.nodes에 보관). 껍데기 push(appendIteration) + build(buildIteration).
    // 새 회차의 전역 branchIndex를 돌려준다.
    // 몸체 `${i}`가 읽을 회차변수(인덱스) 슬롯 [RAW, i]를 바깥 스코프 뒤에 붙인다. 슬롯 번호 =
    // props+바깥 회차변수 뒤.
    const addIterationBranch = (i: number) => {
      const newBranchIndex = vm.appendIteration(forRegionIndex);
      vm.branchAt(newBranchIndex).nodes = Array.from(
        (
          vm.buildIteration(
            RAW,
            i,
            bodyStart,
            forEndPc,
            newBranchIndex,
            scopeWithIteration(argumentSourcePairs, RAW, i, RAW, i), // item(회차값)/index 모두 [RAW,i](count-for는 중간 제거 없어 인덱스 상수)
            compId,
            pathPrefix,
            loopIndexBase,
            stacks,
          ) as DocumentFragment
        ).childNodes, // 이 해석기는 늘 fragment를 낸다
      );
      return newBranchIndex;
    };

    const initial = Number(vm.store.get(countLeafIndex)) || 0;
    for (let i = 0; i < initial; i++) {
      addIterationBranch(i);
    }

    const onCount = (v: unknown) => {
      vm.resizeFor(forRegionIndex, Number(v) || 0, addIterationBranch);
    };
    vm.subscribeOnBranch(branch, countLeafIndex, onCount); // 부모 가지와 생애를 함께 한다
  };

  // 배열 반응 @for - reactiveCountFor와 같은 구조(전용 region + 회차 branch + 길이 구독으로 grow/shrink)로,
  // 다른 점은 회차변수 slot이 count처럼 [RAW, i]가 아니라 그 요소 leaf에 [STORE, elemStartLeafIndices[i]]로
  // 붙는다는 것뿐이다(몸체가 요소 필드를 store에서 읽는다). 배열 요소 수는 store 값이 아니라
  // info.elemStartLeafIndices.length가 진실이라, 발화용 길이 칸(sizeLeafIndex)을 여기서 lazy 확보해
  // (이 배열이 @for에 쓰일 때만) 요소 수를 심고 구독한다. push가 요소를 elemStartLeafIndices에 넣고
  // 그 칸을 set하면 이 구독이 깨어 늘어난 꼬리만 build+attach한다.
  reactiveArrayFor = (
    vm: VM,
    arrayLeafIndex: number,
    bodyStart: number,
    forEndPc: number,
    parent: Node,
    branch: TBranch,
    argumentSourcePairs: TScope,
    compId: number,
    pathPrefix: string,
    loopIndexBase: number,
    walkStacks: TWalkStacks,
  ) => {
    const info = vm.arrayInfoOf(arrayLeafIndex);
    const sizeLeafIndex = vm.ensureIterationLeaves(info);

    const forRegionIndex = vm.openForRegion(branch, sizeLeafIndex);
    info.forRegionIndices.push(forRegionIndex); // removeAt이 이 region들의 회차 DOM을 뗀다(같은 배열을 여러 @for가 순회할 수 있다)
    const region = vm.regionAt(forRegionIndex);
    parent.appendChild(region.anchor);

    // grow(onSize 발화)는 지연 실행이라 그 시점 공유 walkStacks는 이 @for 지점을 지나 이미 pop돼
    // 있다(@if lazyBuild와 동형). build 시점 상태를 딥카피해 addIterationBranch가 캡처한다 - 초기
    // 회차도 같은 스냅샷을 쓴다(build 시점이라 값 동일, push/pop도 스냅샷에만 가 원본 무오염).
    const stacks = snapshotStacks(walkStacks);

    // array-for는 슬롯 2칸 - [STORE, 요소 base], [STORE, 인덱스 leaf] 순. 요소 슬롯은 몸체가 요소 필드를,
    // 인덱스 슬롯은 몸체 ${i}가 읽는다. 인덱스 leaf는 발화 시 $n으로도 해소되게 loopIndexStack에
    // (STORE, 인덱스 leaf)로 실어 물려준다. 슬롯 번호 = props + 바깥 슬롯 뒤.
    const addIterationBranch = (i: number) => {
      const newBranchIndex = vm.appendIteration(forRegionIndex);
      const indexLeaf = info.indexLeafIndices[i];
      vm.branchAt(newBranchIndex).nodes = Array.from(
        (
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
          ) as DocumentFragment
        ).childNodes, // 이 해석기는 늘 fragment를 낸다
      );
      return newBranchIndex;
    };

    for (let i = 0; i < info.elemStartLeafIndices.length; i++) {
      addIterationBranch(i);
    }

    const onSize = () => {
      // store 값이 아니라 요소 목록 길이가 진실
      vm.resizeFor(forRegionIndex, info.elemStartLeafIndices.length, addIterationBranch);
    };
    vm.subscribeOnBranch(branch, sizeLeafIndex, onSize);
  };

  // 범위(startPc~endPc)의 템플릿 복제 계획. 범위마다 처음 한 번 만들어 둔다.
  //
  // 범위가 아래 명령만으로 되어 있으면 뼈대를 DOM으로 만들고 값 자리를 적는다. 하나라도 다른 명령
  // (@if, @for, 합성, 슬롯, @with)이 섞이면 null - interpret가 지금처럼 해석한다.
  //   뼈대      ELEM_OPEN, ATTR_G, ATTR_L, ELEM_CLOSE_OPEN, ELEM_END, TEXT
  //   값 자리   TEXT_VAR, TEXT_EXPR, ATTR_G_VAR, ATTR_L_VAR, ATTR_G_EXPR, ATTR_L_EXPR, BIND_EVENT
  //   경로 상태  PUSH_PATH_INDEX_SEGMENT(뒤따르는 BIND_EVENT의 [$n])
  //   리소스    LOAD_RES - 노드가 없다. 계획을 만들 때 한 번 로드하고 복제본마다 하지 않는다
  //             (범위가 처음 그려질 때가 계획을 만드는 때고, 중복은 loadedHrefs가 막는다).
  //   끝        HALT - def 범위의 마지막 명령. 노드가 없다.
  //
  // 노드 번호는 노드를 만든 순서다. 요소는 자식보다 먼저, 형제는 앞에서부터 만들므로 이 순서가
  // 곧 뼈대의 앞순회 순서다 - 값 자리의 노드 번호를 앞 값 자리에서의 걸음으로 바꿔 두면(template-steps.ts)
  // 복제본 위에서 걸음을 따라가 같은 노드를 찾는다.
  templatePlanOf = (vm: VM, startPc: number, endPc: number): TTemplatePlan | null => {
    const cached = vm.templatePlanCache.get(startPc);
    if (cached !== undefined) {
      return cached;
    }
    const code = vm.code;
    const u16 = (at: number) => code[at] | (code[at + 1] << 8);
    const template = document.createDocumentFragment();
    const parents: Node[] = [template];
    const holePcs: number[] = [];
    const holeNodeNumbers: number[] = [];
    let pending: HTMLElement | null = null;
    let nodeCount = 0;
    let plannable = true;
    for (let pc = startPc; pc < endPc && plannable; ) {
      const at = pc;
      const op = code[pc++];
      switch (op) {
        case OP_ELEM_OPEN:
          pending = document.createElement(TAGS[u16(pc)]);
          nodeCount++;
          break;
        case OP_ATTR_G:
          // biome-ignore lint/style/noNonNullAssertion: ATTR은 ELEM_OPEN 다음에만 오므로 pending은 non-null(바이트코드 순서 보장)
          pending!.setAttribute(ATTRS[u16(pc)], vm.module.constpool[u16(pc + 2)] as string);
          break;
        case OP_ATTR_L:
          // biome-ignore lint/style/noNonNullAssertion: ATTR은 ELEM_OPEN 다음에만 오므로 pending은 non-null(바이트코드 순서 보장)
          pending!.setAttribute(vm.module.constpool[u16(pc)] as string, vm.module.constpool[u16(pc + 2)] as string);
          break;
        case OP_ATTR_G_VAR:
        case OP_ATTR_L_VAR:
        case OP_ATTR_G_EXPR:
        case OP_ATTR_L_EXPR:
        case OP_BIND_EVENT:
          // 여는 중인 요소가 방금 만든 노드다.
          holePcs.push(at);
          holeNodeNumbers.push(nodeCount - 1);
          break;
        case OP_ELEM_CLOSE_OPEN:
          // biome-ignore lint/style/noNonNullAssertion: CLOSE_OPEN은 ELEM_OPEN 다음에만 오므로 pending은 non-null(바이트코드 순서 보장)
          parents[parents.length - 1].appendChild(pending!);
          // biome-ignore lint/style/noNonNullAssertion: 바로 위와 같은 pending
          parents.push(pending!);
          pending = null;
          break;
        case OP_ELEM_END:
          parents.pop();
          break;
        case OP_TEXT:
          parents[parents.length - 1].appendChild(document.createTextNode(vm.module.constpool[u16(pc)] as string));
          nodeCount++;
          break;
        case OP_TEXT_VAR:
        case OP_TEXT_EXPR:
          parents[parents.length - 1].appendChild(document.createTextNode(""));
          holePcs.push(at);
          holeNodeNumbers.push(nodeCount);
          nodeCount++;
          break;
        case OP_PUSH_PATH_INDEX_SEGMENT:
          holePcs.push(at);
          holeNodeNumbers.push(-1);
          break;
        case OP_LOAD_RES:
          vm.loadResource(u16(pc));
          break;
        case OP_HALT:
          // def의 마지막 명령이다. 읽은 시점에 pc가 endPc라 반복문이 끝난다.
          break;
        default:
          plannable = false;
      }
      pc += operandLen(op);
    }
    let plan: TTemplatePlan | null = null;
    if (plannable) {
      const holes: number[] = [];
      const steps: number[] = [];
      stepsToEachHole(template, holeNodeNumbers).forEach((stepsOfHole, i) => {
        holes.push(holePcs[i], steps.length, steps.length + stepsOfHole.length);
        steps.push(...stepsOfHole);
      });
      plan = { template, holes, steps };
    }
    vm.templatePlanCache.set(startPc, plan);
    return plan;
  };

  // 계획의 뼈대를 복제하고 값 자리에 바인딩을 건다. interpret가 계획이 있는 범위에서 해석 대신 부른다.
  // 값 자리는 interpret와 같은 bindValueSlot/bindEvent로 건다.
  cloneTemplate = (
    vm: VM,
    plan: TTemplatePlan,
    argumentSourcePairs: TScope,
    compId: number,
    pathPrefix: string,
    loopIndexBase: number,
    walkStacks: TWalkStacks,
    branch: TBranch,
  ): DocumentFragment => {
    const fragment = plan.template.cloneNode(true) as DocumentFragment;

    const code = vm.code;
    const { holes, steps } = plan;
    // 커서는 fragment에서 출발해 값 자리마다 계획의 걸음만큼 움직여 그 자리의 노드에 닿는다.
    let node: Node = fragment;
    // interpret의 segment와 같다 - PUSH_PATH_INDEX_SEGMENT가 깔고 다음 BIND_EVENT가 소비한다.
    let segment: string | null = null;
    for (let h = 0; h < holes.length; h += 3) {
      const at = holes[h];
      for (let s = holes[h + 1]; s < holes[h + 2]; s++) {
        const step = steps[s];
        node =
          step === STEP_FIRST_CHILD
            ? (node.firstChild as Node)
            : step === STEP_NEXT_SIBLING
              ? (node.nextSibling as Node)
              : (node.parentNode as Node);
      }
      const op = code[at];
      const pc = at + 1;
      if (op === OP_PUSH_PATH_INDEX_SEGMENT) {
        segment = `${segment ?? ""}[$${loopIndexBase + (code[pc] | (code[pc + 1] << 8))}]`;
      } else if (op === OP_BIND_EVENT) {
        const domEventIndex = code[pc] | (code[pc + 1] << 8);
        const eventIndex = code[pc + 2] | (code[pc + 3] << 8);
        vm.bindEvent(
          node as HTMLElement,
          domEventIndex,
          eventIndex,
          segment,
          compId,
          pathPrefix,
          argumentSourcePairs,
          walkStacks,
        );
        segment = null;
      } else {
        vm.bindValueSlot(op, pc, node, compId, argumentSourcePairs, branch);
      }
    }
    return fragment;
  };

  // 한 가지(startPc~endPc)를 build한다 - 노드는 fragment로 반환, 구독은 해당 가지에 쌓는다.
  //
  // 재진입 가능: 최초 인스턴스화는 루트 전체를, lazy build는 swap으로 처음 켜지는 가지 범위만
  // 해석한다. 자식 IF는 활성 가지를 재귀로 즉시 build하고 비활성 가지엔 lazyBuild만 심는다.
  // RENDER는 자식 def 구간을 자식 argumentSourcePairs로 이 함수에 재진입해 인라인 합성한다(별도 인스턴스/
  // 루트 region 없이 부모 가지 안에 합류).
  //
  // @param vm               상태와 바인딩을 가진 VM(이 해석기는 상태를 들지 않는다)
  // @param argumentSourcePairs            offset -> store 경로 매핑(자식은 자식 argumentSourcePairs)
  // @param compId           지금 해석 중인 def(자식 RENDER면 자식 def). events/contexts를 이 def에서 참조로 꺼낸다.
  // @param startPc, endPc   해석 범위(endPc는 IF_END 직전)
  // @param startBranchIndex 구독을 쌓을 가지의 전역 branchIndex(vm.branchAt(startBranchIndex))
  // @param pathPrefix       이벤트 fullname의 누적 경로(루트 ""). RENDER가 자식 type-name을 잇는다(불변 값).
  // @param loopIndexBase    자식 @for 세그먼트 인덱스의 base(누적 @for 깊이). RENDER가 늘린다(불변 값).
  // @param walkStacks               가변 walk 스택(loopIndexStack/activeContexts). @for/RENDER는 이어 쓰고, @if 비활성 가지는 카피본을 쓴다.
  // @param slotPlaceholderContents  사용쪽(부모)이 RENDER로 넘긴 슬롯 콘텐츠. 인덱스 = 이 def의 @slot 선언 순서, 미채움 슬롯은 구멍(undefined).
  // @returns                직속 노드를 담은 DocumentFragment
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
  ): DocumentFragment => {
    // 요소/텍스트/값 자리/이벤트만으로 된 범위(@for 회차 본문 등)는 해석하지 않고 뼈대를 복제한다.
    const plan = this.templatePlanOf(vm, startPc, endPc);
    if (plan !== null) {
      return this.cloneTemplate(
        vm,
        plan,
        argumentSourcePairs,
        compId,
        pathPrefix,
        loopIndexBase,
        walkStacks,
        vm.branchAt(startBranchIndex),
      );
    }
    const fragment = document.createDocumentFragment();
    const nodeStack: Node[] = [fragment]; // 노드 스택 - DOM 부모 추적
    let pending: HTMLElement | null = null;
    let args = [];
    let segment: string | null = null; // 다음 RENDER/BIND_EVENT가 소비할 경로 세그먼트(PUSH_PATH_SEGMENT/INDEX가 적재)
    // 다음 RENDER가 소비할 슬롯 콘텐츠(PUSH_SLOT_PLACEHOLDER_CONTENT가 적재). args와 같은 생애 -
    // RENDER가 자식에 넘기고 비운다. 인덱스 = 자식 def의 @slot 선언 순서라 미채움은 구멍으로 남는다.
    let pendingSlotPlaceholderContents: (TSlotPlaceholderContent | undefined)[] = [];
    let pc = startPc;

    // 이 interpret이 채우는 가지. 한 호출 = 한 가지라 불변(중첩 if는 재귀 호출이 자식 가지를
    // 새 컨텍스트로 받는다 - JS 호출 스택이 옛 region/branch 스택 역할을 대신한다).
    const branch = vm.branchAt(startBranchIndex); // startBranchIndex는 전역 branchIndex

    const u16at = () => {
      const v = vm.code[pc] | (vm.code[pc + 1] << 8);
      pc += 2;
      return v;
    };
    const u8at = () => vm.code[pc++];
    const nodeTop = () => nodeStack[nodeStack.length - 1];

    while (pc < endPc) {
      const op = vm.code[pc++];
      switch (op) {
        case OP_HALT: {
          pc = endPc;
          break;
        }
        case OP_LOAD_RES: {
          vm.loadResource(u16at());
          break;
        }
        case OP_ELEM_OPEN: {
          const tag = TAGS[u16at()];
          pending = document.createElement(tag);
          break;
        }
        case OP_ATTR_G: {
          const name = ATTRS[u16at()];
          // biome-ignore lint/style/noNonNullAssertion: ATTR은 ELEM_OPEN 다음에만 오므로 pending은 non-null(바이트코드 순서 보장)
          pending!.setAttribute(name, vm.module.constpool[u16at()] as string);
          break;
        }
        case OP_ATTR_L: {
          const name = vm.module.constpool[u16at()] as string;
          // biome-ignore lint/style/noNonNullAssertion: ATTR은 ELEM_OPEN 다음에만 오므로 pending은 non-null(바이트코드 순서 보장)
          pending!.setAttribute(name, vm.module.constpool[u16at()] as string);
          break;
        }
        case OP_ATTR_G_VAR:
        case OP_ATTR_L_VAR:
        case OP_ATTR_G_EXPR:
        case OP_ATTR_L_EXPR: {
          // biome-ignore lint/style/noNonNullAssertion: ATTR은 ELEM_OPEN 다음에만 오므로 pending은 non-null(바이트코드 순서 보장)
          vm.bindValueSlot(op, pc, pending!, compId, argumentSourcePairs, branch);
          pc += operandLen(op);
          break;
        }
        case OP_BIND_EVENT: {
          // 지금 여는 요소(pending)에 리스너를 단다. event_type=DOM 이벤트, event_idx=이 def의 이벤트.
          const domEventIndex = u16at();
          const eventIndex = u16at();
          vm.bindEvent(
            // biome-ignore lint/style/noNonNullAssertion: BIND_EVENT는 ELEM_OPEN 다음에만 오므로 pending은 non-null(바이트코드 순서 보장)
            pending!,
            domEventIndex,
            eventIndex,
            segment,
            compId,
            pathPrefix,
            argumentSourcePairs,
            walkStacks,
          );
          // segment는 PUSH_PATH_INDEX_SEGMENT가 이 element에 깐 [$n]이다(RENDER를 안 거치니 여기서
          // 소비). 이벤트 있는 element마다 새로 깔리므로 소비(비움)해도 형제/중첩이 다시 깐다.
          segment = null;
          break;
        }
        case OP_ELEM_CLOSE_OPEN: {
          // biome-ignore lint/style/noNonNullAssertion: CLOSE_OPEN은 ELEM_OPEN 다음에만 오므로 pending은 non-null(바이트코드 순서 보장)
          nodeTop().appendChild(pending!);
          // biome-ignore lint/style/noNonNullAssertion: 바로 위와 같은 pending
          nodeStack.push(pending!);
          pending = null;
          break;
        }
        case OP_TEXT: {
          const text = vm.module.constpool[u16at()] as string;
          nodeTop().appendChild(document.createTextNode(text));
          break;
        }
        case OP_TEXT_VAR:
        case OP_TEXT_EXPR: {
          const node = document.createTextNode("");
          vm.bindValueSlot(op, pc, node, compId, argumentSourcePairs, branch);
          pc += operandLen(op);
          nodeTop().appendChild(node);
          break;
        }
        case OP_ELEM_END: {
          nodeStack.pop();
          break;
        }
        case OP_PUSH_THROUGH: {
          // 경로 없는 참조 - 부모 슬롯 (kind, ref)를 편집 없이 그대로 자식에 넘긴다. kind를
          // 보존해 부모가 리터럴로 받은 CONST 슬롯도 그대로 아래로 흐른다.
          const scopeIndex = u8at();
          args.push(slotKind(argumentSourcePairs, scopeIndex), slotRef(argumentSourcePairs, scopeIndex));
          break;
        }
        case OP_PUSH_FIELD: {
          // 필드 참조 - 부모 슬롯 base에 offset을 더해 자식에 넘긴다. kind는 그대로 전파,
          // 위치만 옮긴다. CONST 슬롯은 필드가 없어(리터럴은 객체 아님) FIELD로 오지 않는다.
          const scopeIndex = u8at();
          const offset = u8at();
          args.push(slotKind(argumentSourcePairs, scopeIndex), slotRef(argumentSourcePairs, scopeIndex) + offset);
          break;
        }
        case OP_PUSH_ARG_LIT: {
          // 리터럴 인자(불변): 상수풀 인덱스를 CONST 슬롯으로 자식에 넘긴다. store에 심지
          // 않는다 - 소비 지점(bindVar)이 CONST를 보고 pool을 직접 읽고 구독을 스킵한다.
          args.push(CONST, u16at());
          break;
        }
        case OP_PUSH_PATH_SEGMENT: {
          // 다음 RENDER가 자식 경로 prefix에 이을 세그먼트(자식 type-name). 합성당 하나라
          // 단일 변수로 적재 - args(여럿 누적)와 달리 RENDER가 하나만 소비한다.
          segment = vm.module.constpool[u16at()] as string;
          break;
        }
        case OP_PUSH_PATH_INDEX_SEGMENT: {
          // @for 인덱스 세그먼트를 정적 fullname에 접미한다. 직전 이름 세그먼트가 있으면
          // Row[$0], 없으면(element 직속) 익명 [$0]. operand는 컴포넌트-로컬 깊이라 use-site에서
          // 물려받은 깊이(loopIndexStack.length)를 base로 더해 누적 표기($1...)로 만든다 - 자식
          // 컴포넌트 코드는 자기 @for를 0부터 세지만 fullname은 바깥까지 누적돼야 한다.
          const token = `[$${loopIndexBase + u16at()}]`;
          segment = (segment ?? "") + token;
          break;
        }
        case OP_ENTER_CONTEXT: {
          // @with 진입: 어느 컨텍스트인지와 지금 argumentSourcePairs를 activeContexts에 push. 필드는 발생 시점
          // BIND_EVENT가 처음 바인딩할 때 leafIndex로 푼다(contextFieldsOf).
          const contextIndex = u16at();
          const contextDef = vm.componentContexts(compId)[contextIndex];
          const name = vm.module.constpool[contextDef.nameConstIndex as number] as string;
          // 맥락은 같은 이름이 중복으로 쌓이지 않는 게 맞다(ISSUES). 일어나면 알리고, 가장
          // 안쪽이 이기도록 그냥 쌓는다(context 조립이 뒤(=안쪽) 것으로 덮는다).
          if (walkStacks.activeContexts.some((active) => active.name === name)) {
            console.warn(`quble: 컨텍스트 '${name}'가 중복 활성화됐습니다(안쪽이 우선).`);
          }
          walkStacks.activeContexts.push({ name, compId, contextIndex, scope: argumentSourcePairs, fields: null });
          break;
        }
        case OP_EXIT_CONTEXT: {
          // @with 블록 끝. 활성 스택에서 뺀다.
          walkStacks.activeContexts.pop();
          break;
        }
        case OP_PUSH_SLOT_PLACEHOLDER_CONTENT: {
          // 콘텐츠 구간을 재서 담아두기만 한다 - 실행은 자식의 FILL_SLOT_PLACEHOLDER 자리에서.
          // 지금 컨텍스트(부모)를 함께 캡처한다: 콘텐츠는 부모 def 안이라 부모 scope/path로 읽힌다.
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
          pc = contentEndPc + 1; // SLOT_PLACEHOLDER_CONTENT_END 마커 소비
          break;
        }
        case OP_FILL_SLOT_PLACEHOLDER: {
          // `@slot` 자리(정의쪽). 부모가 안 채웠으면 구멍이라 아무것도 안 넣는다(미채움 허용).
          const content = slotPlaceholderContents[u16at()];
          if (content === undefined) {
            break;
          }
          // 세 축이 갈린다: 해석 컨텍스트/수명(구독 가지)은 부모 것, DOM 부착 위치만 자식 자리.
          // 콘텐츠 안 합성은 자기 슬롯을 스스로 채우므로 여기 재진입엔 넘길 게 없다.
          const slotFragment = this.interpret(
            vm,
            content.argumentSourcePairs,
            content.compId,
            content.startPc,
            content.endPc,
            content.branchIndex,
            content.pathPrefix,
            content.loopIndexBase,
            content.walkStacks,
          );
          nodeTop().appendChild(slotFragment);
          break;
        }
        case OP_RENDER: {
          const childCompId = u16at();
          const childArgumentSourcePairs = args;
          args = [];
          const childSlotPlaceholderContents = pendingSlotPlaceholderContents;
          pendingSlotPlaceholderContents = [];
          // 자식 경로 prefix = 부모 prefix + 세그먼트. 이벤트 fullname의 path 축을 누적한다.
          const childPrefix = pathPrefix ? `${pathPrefix}.${segment}` : segment;
          segment = null;
          // 합성 = 인라인 재진입. 자식 def의 code 구간을 자식 argumentSourcePairs로 같은 interpret에 돌린다.
          // 시작 가지 = 지금 이 가지(startBranchIndex) -> 자식 IF는 이 가지의
          // childRegionIndices에 합류하고 같은 regionPool 배열에 append된다(인덱스 전역 유일).
          // 자식 루트 region 없음 - 자식 직속 노드는 fragment로 모여 RENDER 위치에 붙는다.
          const childDef = vm.module.defs[childCompId];
          const childFragment = this.interpret(
            vm,
            childArgumentSourcePairs,
            childCompId, // 자식 BIND_EVENT/ENTER_CONTEXT는 자식 def의 이벤트/컨텍스트 테이블을 본다
            childDef.codeOff,
            childDef.codeOff + childDef.codeLen,
            startBranchIndex,
            // biome-ignore lint/style/noNonNullAssertion: RENDER 지점엔 PUSH_PATH_SEGMENT가 깐 segment가 있어 childPrefix는 non-null(바이트코드 순서 보장)
            childPrefix!,
            walkStacks.loopIndexStack.length / 2, // 자식 세그먼트 인덱스의 base = 여기까지 누적된 @for 깊이(스택은 인터리브라 /2)
            walkStacks, // 회차 인덱스/컨텍스트 스택을 공유로 물려준다 - @for/@with 경계가 push/pop으로 원복(복사 없음)
            childSlotPlaceholderContents, // 자식 @slot 자리가 꺼내 쓸 콘텐츠(부모 컨텍스트를 이미 캡처해 둠)
          );
          // fragment를 통째로 붙인다 - appendChild(fragment)는 내용 전체를 한 번에 옮기고
          // fragment를 비운다(노드별 재입양 대신 1회). 노드 하나씩 옮기면 안 된다: childNodes는
          // 라이브라 순회 중 인덱스가 밀려 건너뛴다.
          nodeTop().appendChild(childFragment);
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
            nodeTop(),
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
            nodeTop(),
          );
          break;
        }
        case OP_FOR_RAW: {
          // 소스에 박힌 리터럴 횟수 - 안 변하니 지금 가지(startRegion/Branch)에 count회 인라인.
          const count = Number(u16at()) || 0;
          const bodyStart = pc;
          const forEndPc = vm.cachedForEnd(bodyStart);
          this.inlineFor(
            vm,
            count,
            bodyStart,
            forEndPc,
            nodeTop(),
            startBranchIndex,
            argumentSourcePairs,
            compId,
            pathPrefix,
            loopIndexBase,
            walkStacks,
          );
          pc = forEndPc + 1; // FOR_END 마커 소비 - @for 다음으로.
          break;
        }
        case OP_FOR_COUNT_VAR: {
          // 숫자 count slot(@if 조건과 동형). CONST(부모가 리터럴로 준 prop)와 RAW(바깥 개수 반복의
          // 회차 번호)는 안 변하니 인라인, STORE는 count leaf에 구독을 걸어 값이 바뀌면 꼬리 회차를
          // 늘리고 줄인다. count가 필드(a.count)면 base+offset이 그 leaf.
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
              nodeTop(),
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
              nodeTop(),
              branch,
              argumentSourcePairs,
              compId,
              pathPrefix,
              loopIndexBase,
              walkStacks,
            );
          }
          pc = forEndPc + 1; // FOR_END 마커 소비 - @for 다음으로.
          break;
        }
        case OP_FOR_ARRAY_VAR: {
          // 배열 count slot. 배열 칸에 든 arrayInfoIndex로 요소 수/요소 위치를 얻어, 회차마다
          // 회차변수(item) slot을 그 요소 leaf로 바인딩하며 반복한다. item slot은 codegen과 같은
          // 규칙(props 슬롯 수 + 현재 @for 깊이)으로 계산한다. base+offset이 배열 칸의 leaf.
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
            nodeTop(),
            branch,
            argumentSourcePairs,
            compId,
            pathPrefix,
            loopIndexBase,
            walkStacks,
          );
          pc = forEndPc + 1; // FOR_END 마커 소비 - @for 다음으로.
          break;
        }
        default: {
          throw new Error(`bad opcode 0x${op.toString(16)}`);
        }
      }
    }
    return fragment;
  };

  // @if opcode 처리 - 조건 슬롯을 그대로 조건 칸으로 쓴다.
  // pc는 IF operand 직후(cond 슬롯)를 가리켜 들어오고, IF_END 다음 pc를 돌려준다.
  runIf = (
    vm: VM,
    pc: number,
    argumentSourcePairs: TScope,
    compId: number,
    pathPrefix: string,
    loopIndexBase: number,
    walkStacks: TWalkStacks,
    branch: TBranch,
    parent: Node,
  ): number => {
    const condScopeIndex = vm.code[pc++];
    const condOffset = vm.code[pc++];
    // 조건 슬롯도 STORE/CONST 위임 처리. CONST(부모가 리터럴로 준 prop)는 값이 안
    // 변하니 leafIndex도 구독도 없다 - condLeafIndex=-1(region이 이 값을 읽지 않는다).
    const condIsConst = slotKind(argumentSourcePairs, condScopeIndex) === CONST;
    const condRef = slotRef(argumentSourcePairs, condScopeIndex);
    const condLeafIndex = condIsConst ? -1 : condRef + condOffset;
    return this.buildIfRegion(
      vm,
      pc,
      condLeafIndex,
      condIsConst ? vm.module.constpool[condRef] : vm.store.get(condLeafIndex),
      argumentSourcePairs,
      compId,
      pathPrefix,
      loopIndexBase,
      walkStacks,
      branch,
      parent,
    );
  };

  // IF_EXPR opcode 처리 - 연산자가 붙은 조건(BYTECODE.md #5.2). 식의 결과를 담을 파생 칸을 하나
  // 잡고, 식이 읽는 칸들을 구독해 하나라도 바뀌면 다시 세어 그 칸에 넣는다. 분기는 그 칸 하나만
  // 보므로 그 뒤는 IF와 같다.
  runIfExpr = (
    vm: VM,
    pc: number,
    argumentSourcePairs: TScope,
    compId: number,
    pathPrefix: string,
    loopIndexBase: number,
    walkStacks: TWalkStacks,
    branch: TBranch,
    parent: Node,
  ): number => {
    const expr = vm.module.defs[compId].exprs[vm.code[pc++]];
    // 식이 읽는 칸이 바뀌면 식을 다시 센 값을 구독 층이 결과 leaf(condLeafIndex)에 write한다. 그 값이 바뀌면
    // 아래 buildIfRegion이 건 통지 구독이 불려 가지를 바꾼다 - 두 단계인 이유는 감시 칸과 조건 칸이 다르기
    // 때문이다. 파생 구독은 부모 가지에 실어 생애를 함께 한다. 결과 leaf는 식의 첫 값으로 잡으므로 식을 센
    // 뒤에 만들어 연결한다.
    const { value, derive } = vm.subscribeExpr(expr, argumentSourcePairs, branch);
    const condLeafIndex = vm.store.alloc([value]);
    vm.store.bindDeriveResult(derive, condLeafIndex);
    return this.buildIfRegion(
      vm,
      pc,
      condLeafIndex,
      vm.store.get(condLeafIndex),
      argumentSourcePairs,
      compId,
      pathPrefix,
      loopIndexBase,
      walkStacks,
      branch,
      parent,
    );
  };

  // IF/IF_EXPR이 공유하는 분기 구성 - then/else Region을 스폰해 anchor를 parent에 붙이고, 활성
  // 가지만 build한다. 비활성 가지엔 lazyBuild만 심어 첫 활성화 때 만든다. 조건 칸이 있으면(STORE)
  // 구독을 걸어 swap한다.
  //
  // 둘의 차이는 조건 칸을 어디서 얻느냐뿐이다 - IF는 부모 슬롯을 그대로 쓰고, IF_EXPR은 식을
  // 세어 넣은 파생 칸을 쓴다. 그래서 그 칸과 초기값만 받는다.
  //
  // @param pc             가지 첫 op(조건 operand 직후)
  // @param condLeafIndex  조건을 담은 칸. CONST 조건이면 -1(구독 없음)
  // @param condInitial    초기 조건값 - CONST 조건은 store에 없어 따로 받는다
  // @param branch         구독을 실을 부모 가지 - 부모가 detach/free되면 조건 감시도 꺼진다
  // @param parent         anchor를 붙일 DOM 노드
  // @returns              IF_END 다음 pc
  buildIfRegion = (
    vm: VM,
    pc: number,
    condLeafIndex: number,
    condInitial: unknown,
    argumentSourcePairs: TScope,
    compId: number,
    pathPrefix: string,
    loopIndexBase: number,
    walkStacks: TWalkStacks,
    branch: TBranch,
    parent: Node,
  ): number => {
    // anchor(if 자리 고정용 주석)는 여기서 DOM 트리에 붙인다. 가지 build는 VM이 한다.
    const anchor = document.createComment("");
    parent.appendChild(anchor);
    return vm.openIfRegion(
      pc,
      condLeafIndex,
      condInitial,
      argumentSourcePairs,
      compId,
      pathPrefix,
      loopIndexBase,
      walkStacks,
      branch,
      anchor,
    );
  };
}
