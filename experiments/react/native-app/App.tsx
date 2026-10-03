// native_demo.qubc를 `quble-react --native`로 컴파일한 산출(../dist/native/native_demo.tsx)을 그린다.
// 핸들러와 초기 데이터는 브라우저 확인 셸(../native-web)과 같은 파일이다.
import { QubleRoot } from "quble-react";
import { StatusBar, View } from "react-native";
import { NativeDemo } from "../dist/native/native_demo";
import { handlers } from "../native-web/src/handlers";
import { initial } from "../native-web/src/initial";

// Android 15부터 앱이 상태 표시줄 밑까지 그려지므로 그 높이만큼 내린다.
export const App = () => (
  <View style={{ flex: 1, paddingTop: StatusBar.currentHeight ?? 0, backgroundColor: "#fff" }}>
    <QubleRoot<Parameters<typeof NativeDemo>[0]> component={NativeDemo} initial={initial} handlers={handlers} />
  </View>
);
