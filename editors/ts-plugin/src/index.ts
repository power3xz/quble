// tsserver가 require로 싣는 진입점. module.exports가 함수 자체이길 기대하므로 `export =`다.
//
// 그 형식은 named export와 함께 쓸 수 없어 본체를 plugin.ts에 두고 여기서는 내보내기만
// 한다 - 테스트가 본체를 이름으로 import할 수 있어야 한다(proxy.test.ts).

import { pluginInit } from "./plugin.ts";

export = pluginInit;
