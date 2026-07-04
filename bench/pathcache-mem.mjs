// pathCache(Map<path-string, leafIndex>)가 실제로 먹는 메모리 측정.
// 배열 요소 많고 중첩 깊을 때 캐시 키(문자열) 비용을 본다.
//
// 실행: node --expose-gc pathcache_mem.mjs

const mb = (b) => (b / 1024 / 1024).toFixed(2) + " MB";

const measure = (label, build) => {
  global.gc(); global.gc();
  const before = process.memoryUsage().heapUsed;
  const retained = build();               // 참조 유지(GC 방지)
  global.gc(); global.gc();
  const after = process.memoryUsage().heapUsed;
  console.log(`${label.padEnd(48)} ${mb(after - before)}  (keys: ${retained.size ?? retained.length})`);
  return retained;
};

// 실제로 길고 서술적인 필드명 풀 (현업 도메인 모델처럼)
const FIELD_POOL = [
  "displayName", "primaryEmailAddress", "organizationRole", "avatarImageUrl",
  "onlineStatus", "lastActiveTimestamp", "notificationPreference", "phoneNumber",
  "departmentIdentifier", "employmentStartDate", "managerReferenceId", "isAccountVerified",
];

// 경로 모양: organizations[o].departments[d].teams[t].members[m].profileDetails.<leaf>
// depth 인자로 중첩 배열 단계 수를 조절한다. leaves = 멤버당 말단 필드 수.
const buildPaths = (counts, leaves) => {
  const fields = FIELD_POOL.slice(0, leaves);
  const segNames = ["organizations", "departments", "teams", "members"];
  const paths = [];
  const rec = (level, prefix) => {
    if (level === counts.length) {
      for (const f of fields) paths.push(`${prefix}.profileDetails.${f}`);
      return;
    }
    for (let i = 0; i < counts[level]; i++) {
      rec(level + 1, `${prefix}${prefix ? "." : ""}${segNames[level]}.${i}`);
    }
  };
  rec(0, "");
  return paths;
};

const run = (counts, leaves, label) => {
  const paths = buildPaths(counts, leaves);
  const total = paths.length;
  const sampleLen = paths[0].length;
  console.log(`\n=== ${label}  (${counts.join("×")}), leaves=${leaves} → ${total} 경로, 키길이~${sampleLen}자 ===`);
  console.log(`    예: ${paths[0]}`);

  // A. 현재 방식: pathCache = Map<path-string, leafIndex>
  measure("A. pathCache Map<string, int>", () => {
    const m = new Map();
    for (let i = 0; i < paths.length; i++) m.set(paths[i], i);
    return m;
  });

  // B. 문자열 키 배열만 (Map 오버헤드 제외, 순수 문자열 보유 비용)
  measure("B. 문자열 키 배열만", () => paths.slice());

  // C. 정수 leafIndex만 (문자열 키 없이 번호만 보관 - 대안 하한)
  measure("C. Int32Array (leafIndex만)", () => {
    const a = new Int32Array(total);
    for (let i = 0; i < total; i++) a[i] = i;
    return a;
  });
};

// 깊이·요소수·필드수를 순차로 키운다
run([100, 100], 5, "얕음: 1만 멤버, 필드 5");            // 50,000 경로
run([10, 10, 10, 10], 12, "깊음: 4단중첩 1만 멤버, 필드 12"); // 120,000 경로
run([10, 10, 10, 100], 12, "깊고 넓음: 10만 멤버, 필드 12");  // 1,200,000 경로
