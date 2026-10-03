const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

// 앱 밖의 소스(런타임, RN 산출, 핸들러)를 싣는다. 그 파일들이 `react`를 import하는데, 상위
// experiments/react/node_modules에도 웹용 React가 있다. 둘이 겹치면 RN이 깨지므로 모듈 탐색을 이 앱의
// node_modules 하나로 고정한다.
const experiment = path.resolve(__dirname, "..");
const config = getDefaultConfig(__dirname);

config.watchFolders = [
  path.join(experiment, "runtime"),
  path.join(experiment, "dist"),
  path.join(experiment, "native-web"),
];
config.resolver.nodeModulesPaths = [path.join(__dirname, "node_modules")];
config.resolver.disableHierarchicalLookup = true;

const quble = path.join(experiment, "runtime", "index.ts");
const resolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "quble-react") {
    return { type: "sourceFile", filePath: quble };
  }
  return (resolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
