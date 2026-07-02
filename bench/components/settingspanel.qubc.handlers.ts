import type { Handlers } from "./settingspanel.qubc";

// 설정 패널 핸들러. open/enabled는 bool prop이라 get/set이 boolean으로 오간다.
// @if가 실제 boolean에 반응하므로 토글이 화면(섹션 접힘/펼침, 스위치 on/off)에 그대로 보인다.
//
// dirty(저장 필요 표시)는 아직 못 켠다: 핸들러가 자기 컴포넌트 prop만 set할 수 있는데
// dirty는 부모(SettingsPanel)의 prop이라 자식 토글에서 닿지 않는다(ISSUES 참고). 그래서
// SAVE/DISCARD 버튼은 dirty=false 고정이라 뜨지 않고, 두 핸들러는 store/reactivity 모델이
// 정해진 뒤 채운다.

const handlers: Partial<Handlers> = {
  // 섹션 헤더 클릭 - open을 반전해 펼침/접힘.
  "General.TOGGLE_SECTION": (data, { props, get, set }) => {
    set(props.open, !get(props.open));
  },
  "Privacy.TOGGLE_SECTION": (data, { props, get, set }) => {
    set(props.open, !get(props.open));
  },
  "Premium.TOGGLE_SECTION": (data, { props, get, set }) => {
    set(props.open, !get(props.open));
  },

  // 행 스위치 클릭 - enabled를 반전해 on/off.
  "General.FirstRow.TOGGLE": (data, { props, get, set }) => {
    set(props.enabled, !get(props.enabled));
  },
  "General.SecondRow.TOGGLE": (data, { props, get, set }) => {
    set(props.enabled, !get(props.enabled));
  },
  "Privacy.FirstRow.TOGGLE": (data, { props, get, set }) => {
    set(props.enabled, !get(props.enabled));
  },
  "Privacy.SecondRow.TOGGLE": (data, { props, get, set }) => {
    set(props.enabled, !get(props.enabled));
  },
  "Premium.FirstRow.TOGGLE": (data, { props, get, set }) => {
    set(props.enabled, !get(props.enabled));
  },
  "Premium.SecondRow.TOGGLE": (data, { props, get, set }) => {
    set(props.enabled, !get(props.enabled));
  },
};

export default handlers;
