// 소유 트리의 위쪽 간선 - 가지 -> 품은 Region, Region -> 품은 가지, 식 인스턴스 -> 든 가지. 아래쪽 간선은 Region과
// 가지가 든다(region.ts의 branchIndices, childRegionIndices, exprInstanceIndices). flush가 바뀐 leaf에서 시작해 그
// 식 인스턴스가 고른 쪽에 있는지 루트까지 올라가 볼 때 쓴다.
//
//   식 인스턴스 --> 가지 --> Region --> 가지 --> ... --> 루트 Region(부모 가지 NO_PARENT)
//
// 번호는 모두 풀 인덱스라 그 번호를 위치로 하는 배열에 둔다. 풀이 번호를 재사용하면 새로 기록한 값이 덮는다.

// 루트 Region에는 품은 가지가 없다.
export const NO_PARENT = -1;

export class OwnershipTree {
  // branchIndex -> 그 가지를 품은 regionIndex.
  private regionOfBranchIndex: number[] = [];
  // regionIndex -> 그 Region을 품은 branchIndex. 루트 Region은 NO_PARENT.
  private parentBranchOfRegionIndex: number[] = [];
  // exprInstanceIndex -> 그 인스턴스를 든 가지. 대부분 하나라 번호 그대로 두고, 공유로 둘째가 들어오면 배열로 바꾼다.
  // 마지막 가지를 빼면 undefined로 비워, 그 번호를 재사용한 인스턴스가 옛 가지를 물려받지 않게 한다.
  private branchesOfExprInstanceIndex: Array<number | number[] | undefined> = [];

  setRegionOfBranch = (branchIndex: number, regionIndex: number): void => {
    this.regionOfBranchIndex[branchIndex] = regionIndex;
  };

  setParentBranchOfRegion = (regionIndex: number, parentBranchIndex: number): void => {
    this.parentBranchOfRegionIndex[regionIndex] = parentBranchIndex;
  };

  addBranchOfExprInstance = (exprInstanceIndex: number, branchIndex: number): void => {
    const current = this.branchesOfExprInstanceIndex[exprInstanceIndex];
    if (current === undefined) {
      this.branchesOfExprInstanceIndex[exprInstanceIndex] = branchIndex;
    } else if (typeof current === "number") {
      this.branchesOfExprInstanceIndex[exprInstanceIndex] = [current, branchIndex];
    } else {
      current.push(branchIndex);
    }
  };

  // 식 인스턴스를 든 가지에서 branchIndex를 빼고 남은 가지 수를 돌려준다. 0이면 인스턴스를 든 가지가 더 없다.
  removeBranchOfExprInstance = (exprInstanceIndex: number, branchIndex: number): number => {
    const current = this.branchesOfExprInstanceIndex[exprInstanceIndex];
    if (typeof current === "number") {
      this.branchesOfExprInstanceIndex[exprInstanceIndex] = undefined;
      return 0;
    }
    const branches = current as number[];
    branches.splice(branches.indexOf(branchIndex), 1);
    if (branches.length === 1) {
      this.branchesOfExprInstanceIndex[exprInstanceIndex] = branches[0];
    }
    return branches.length;
  };

  regionOfBranch = (branchIndex: number): number => this.regionOfBranchIndex[branchIndex];

  parentBranchOfRegion = (regionIndex: number): number => this.parentBranchOfRegionIndex[regionIndex];

  // 살아 있는 인스턴스만 묻는다 - 든 가지가 하나도 없는 인스턴스는 반납된 뒤다.
  branchesOfExprInstance = (exprInstanceIndex: number): number | number[] =>
    this.branchesOfExprInstanceIndex[exprInstanceIndex] as number | number[];

  clear = (): void => {
    this.regionOfBranchIndex.length = 0;
    this.parentBranchOfRegionIndex.length = 0;
    this.branchesOfExprInstanceIndex.length = 0;
  };
}
