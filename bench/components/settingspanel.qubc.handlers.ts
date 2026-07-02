import type { Handlers } from "./settingspanel.qubc";

// 설정 패널 핸들러. props는 지금 전부 LeafIndex<string>이라(타입 표기 미구현) boolean 상태는
// "true"/"false" 문자열로 다룬다. get/set은 leafIndex로 반응성에 닿는다(REACTIVITY.md §7.1).
//
// 확인용: open/enabled(boolean)는 @if로 렌더되는데 @if가 문자열 "false"를 truthy로 봐서(타입
// 표기 미구현) 화면 토글이 안 보인다. 그래서 눈에 보이는 텍스트(title/label - {title}/{label}로
// 보간)에 상태 표시를 붙여, 버튼 클릭이 화면과 속성 패널에 반영되는 걸 확인할 수 있게 한다.
const flip = (v: string): string => (v === "true" ? "false" : "true");

// "제목" <-> "제목 (접힘)" 처럼 상태를 텍스트 뒤에 토글해 붙인다(화면에 티나게).
const mark = (text: string, suffix: string): string =>
  text.endsWith(suffix) ? text.slice(0, -suffix.length) : text + suffix;

const handlers: Partial<Handlers> = {
  // 섹션 헤더 클릭 - 펼침/접힘 토글. open 상태를 바꾸고, 제목 텍스트에도 표시해 화면에 보이게.
  "General.TOGGLE_SECTION": (data, { props, get, set }) => {
    set(props.open, flip(get(props.open)));
    set(props.title, mark(get(props.title), " (접힘)"));
  },
  "Privacy.TOGGLE_SECTION": (data, { props, get, set }) => {
    set(props.open, flip(get(props.open)));
    set(props.title, mark(get(props.title), " (접힘)"));
  },
  "Premium.TOGGLE_SECTION": (data, { props, get, set }) => {
    set(props.open, flip(get(props.open)));
    set(props.title, mark(get(props.title), " (접힘)"));
  },

  // 행 스위치 클릭 - on/off 토글. enabled 상태를 바꾸고, 라벨 텍스트에도 표시해 화면에 보이게.
  "General.FirstRow.TOGGLE": (data, { props, get, set }) => {
    set(props.enabled, flip(get(props.enabled)));
    set(props.label, mark(get(props.label), " [ON]"));
  },
  "General.SecondRow.TOGGLE": (data, { props, get, set }) => {
    set(props.enabled, flip(get(props.enabled)));
    set(props.label, mark(get(props.label), " [ON]"));
  },
  "Privacy.FirstRow.TOGGLE": (data, { props, get, set }) => {
    set(props.enabled, flip(get(props.enabled)));
    set(props.label, mark(get(props.label), " [ON]"));
  },
  "Privacy.SecondRow.TOGGLE": (data, { props, get, set }) => {
    set(props.enabled, flip(get(props.enabled)));
    set(props.label, mark(get(props.label), " [ON]"));
  },
  "Premium.FirstRow.TOGGLE": (data, { props, get, set }) => {
    set(props.enabled, flip(get(props.enabled)));
    set(props.label, mark(get(props.label), " [ON]"));
  },
  "Premium.SecondRow.TOGGLE": (data, { props, get, set }) => {
    set(props.enabled, flip(get(props.enabled)));
    set(props.label, mark(get(props.label), " [ON]"));
  },

  // 헤더 저장 - 제목에 저장 표시를 붙여 화면에 보이게.
  SAVE: (data, { props, get, set }) => {
    set(props.heading, mark(get(props.heading), " (저장됨)"));
  },
  // 되돌리기 - 제목에 되돌림 표시를 붙여 화면에 보이게.
  DISCARD: (data, { props, get, set }) => {
    set(props.heading, mark(get(props.heading), " (되돌림)"));
  },
};

export default handlers;
