import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";

// React.lazy로 Card를 별도 청크로 분리 → 비동기 로드되는 chunk 크기를 측정.
const Card = lazy(() => import("./Card.jsx"));

createRoot(document.getElementById("root")).render(
  <Suspense fallback={null}>
    <Card />
  </Suspense>
);
