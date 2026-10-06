// SSR이 그린 DOM을 이어받을(resume) 때, 런타임이 노드를 만들던 자리에 대신 넘겨줄 기존 노드를
// 앞순회로 짚는다.
//
// 런타임은 처음 그릴 때 노드를 최종 DOM의 앞순회 순서대로 만든다 - 요소는 자식보다, region 앵커는
// 그 내용보다 먼저. 그래서 SSR DOM을 같은 순서로 짚으면 만들 노드와 짚은 노드가 하나씩 맞는다.
//
// SSR은 HTML에서 사라지는 텍스트 경계를 주석으로 남긴다(crates/renderer).
//   <!---->          이웃한 두 텍스트 노드 사이의 경계 - 지운다
//   <!--qb:empty-->  값이 빈 텍스트 노드 자리 - 빈 텍스트 노드로 바꾼다(resume이 새로 만드는 유일한 노드)

const TEXT_BOUNDARY_MARK = "";
const EMPTY_TEXT_MARK = "qb:empty";
const REGION_ANCHOR_PREFIX = "qb:region#";

export class ResumeCursor {
  nodes: Node[] = [];
  at = 0;

  // root 아래 노드를 앞순회로 모은다(root 자신은 빼고).
  constructor(root: Node) {
    const collect = (node: Node) => {
      for (const child of node.childNodes) {
        this.nodes.push(child);
        collect(child);
      }
    };
    collect(root);
  }

  next = (): Node => {
    if (this.at >= this.nodes.length) {
      throw new Error("resume: SSR 노드가 모자란다");
    }
    return this.nodes[this.at++];
  };

  mismatch = (want: string, got: Node): Error =>
    new Error(`resume: ${want}를 기대했는데 ${got.nodeName}(${got.textContent?.slice(0, 20) ?? ""})를 만났다`);

  element = (tag: string): HTMLElement => {
    const node = this.next();
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

  // 다 짚었는지 - 남았으면 SSR과 런타임이 다른 것을 그렸다.
  finish = (): void => {
    if (this.at < this.nodes.length) {
      throw new Error(`resume: 짚지 않은 SSR 노드 ${this.nodes.length - this.at}개`);
    }
  };
}
