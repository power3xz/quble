import type { Handlers } from "./settingspanel.qubc";

// 설정 패널 핸들러. props는 지금 전부 LeafIndex<string>이라(타입 표기 미구현) boolean 상태는
// "true"/"false" 문자열로 다룬다. get/set은 leafIndex로 반응성에 닿는다(REACTIVITY.md §7.1).
const flip = (v: string): string => (v === "true" ? "false" : "true");

const handlers: Partial<Handlers> = {
  // 섹션 헤더 클릭 - 펼침/접힘 토글.
  "General.TOGGLE_SECTION": (data, { props, get, set }) => {
    set(props.open, flip(get(props.open)));
  },
  "Privacy.TOGGLE_SECTION": (data, { props, get, set }) => {
    set(props.open, flip(get(props.open)));
  },
  "Premium.TOGGLE_SECTION": (data, { props, get, set }) => {
    set(props.open, flip(get(props.open)));
  },

  // 행 스위치 클릭 - on/off 토글. 바꾸면 변경됨(dirty) 표시가 켜져야 하지만, dirty는 루트 스코프라
  // 여기(자식)선 못 건드린다 - 루트 store가 오면(§5.1) 연결된다.
  "General.FirstRow.TOGGLE": (data, { props, get, set }) => {
    set(props.enabled, flip(get(props.enabled)));
  },
  "General.SecondRow.TOGGLE": (data, { props, get, set }) => {
    set(props.enabled, flip(get(props.enabled)));
  },
  "Privacy.FirstRow.TOGGLE": (data, { props, get, set }) => {
    set(props.enabled, flip(get(props.enabled)));
  },
  "Privacy.SecondRow.TOGGLE": (data, { props, get, set }) => {
    set(props.enabled, flip(get(props.enabled)));
  },
  "Premium.FirstRow.TOGGLE": (data, { props, get, set }) => {
    set(props.enabled, flip(get(props.enabled)));
  },
  "Premium.SecondRow.TOGGLE": (data, { props, get, set }) => {
    set(props.enabled, flip(get(props.enabled)));
  },

  // 헤더 저장 - 저장 후 변경 없음 상태로.
  SAVE: (data, { props, set }) => {
    set(props.dirty, "false");
  },
  // 되돌리기 - 변경 폐기.
  DISCARD: (data, { props, set }) => {
    set(props.dirty, "false");
  },
};

export default handlers;
