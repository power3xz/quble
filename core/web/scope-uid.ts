// 스코프 인스턴스(컴포넌트 RENDER 한 번, @for 행 하나)를 구별하는 번호 발급. 단조 증가하고 반납하지 않는다.
// 번호가 Smi 범위를 넘으면 공유 맵 조회가 느려지므로, 한도를 처음 넘을 때 경고를 한 번 찍는다.

// V8이 작은 정수를 힙 할당 없이 담는 범위의 보수적인 상한(포인터 압축을 켠 Chrome 기준).
export const SCOPE_UID_WARN_LIMIT = 2 ** 30;

export class ScopeUidCounter {
  private limit: number;
  private issued = 0;
  private warned = false;

  constructor(limit: number = SCOPE_UID_WARN_LIMIT) {
    this.limit = limit;
  }

  next = (): number => {
    const scopeUid = this.issued++;
    if (scopeUid >= this.limit && !this.warned) {
      this.warned = true;
      console.warn(`quble: scopeUid가 ${this.limit}을 넘었습니다. 식 공유 조회가 조금 느려질 수 있습니다.`);
    }
    return scopeUid;
  };
}
