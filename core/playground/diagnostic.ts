// 컴파일러 진단 텍스트에서 위치를 뽑는다.
//
// 컴파일러(core/crates/compiler/src/diagnostic.rs)가 내는 형식:
//
//   card.qubc:6:14: error: no field `nope` on prop `user`
//     6 |       p() { {user.nope} }
//       |              ^^^^^^^^^
//
// 편집기가 쓰는 건 첫 줄뿐이다 - 아래 두 줄은 소스를 다시 보여주는 것이라 편집기 화면과
// 겹친다. 위치를 못 읽으면(탓할 자리가 없는 codegen 에러는 `path: error: msg`) null이다.

export type TDiagnostic = {
  path: string;
  line: number; // 1부터
  column: number; // 1부터, 문자 기준
  message: string;
};

// `경로:줄:칸: error: 메시지`. 경로에 `:`가 없다고 보지 않으려고 줄/칸을 뒤에서 잡는다.
const HEAD = /^(.*?):(\d+):(\d+): error: (.*)$/;

/** 진단 텍스트의 첫 줄에서 위치를 뽑는다. 위치가 없으면 null. */
export const parseDiagnostic = (text: string): TDiagnostic | null => {
  const matched = HEAD.exec(text.split("\n")[0] ?? "");
  if (!matched) {
    return null;
  }
  return {
    path: matched[1],
    line: Number(matched[2]),
    column: Number(matched[3]),
    message: matched[4],
  };
};
