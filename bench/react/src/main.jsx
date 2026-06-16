import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";

// 각 컴포넌트를 별도 청크로 분리 → 비동기 로드되는 chunk 크기를 측정.
const ProductGrid = lazy(() => import("./ProductGrid.jsx"));
const Article = lazy(() => import("./Article.jsx"));

createRoot(document.getElementById("root")).render(
  <Suspense fallback={null}>
    <ProductGrid />
    <Article />
  </Suspense>
);
