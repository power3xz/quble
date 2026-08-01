const TONES = ["hot", "calm"];

export default {
  CLICK_BADGE: (data, { props, set }) => {
    const tone = TONES[(TONES.indexOf(data.tone) + 1) % TONES.length];
    set(props.tone, tone);
    console.log("배지:", data.text, "/ 톤:", data.tone, "->", tone);
  },
};
