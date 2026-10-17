// 서버에서 그리지 않는 카운터. 페이지가 next/dynamic의 ssr: false로 불러, 브라우저가 빈 컨테이너에 mount한다.
import { createComponent } from "quble/react";
import CounterBytecode from "../fixtures/counter.qubc";

const Counter = createComponent(CounterBytecode);

export default function CsrCounter() {
  return (
    <Counter
      label="CSR"
      count={1}
      handlers={{ CLICK: (_data, { props, get, update }) => update({ count: get(props.count) + 1 }) }}
    />
  );
}
