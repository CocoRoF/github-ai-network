import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import "./index.css";

const GraphPage = lazy(() => import("./pages/GraphPage"));
const AdminPage = lazy(() => import("./pages/AdminPage"));

const PageLoader = () => (
  <div style={{
    display: "flex", alignItems: "center", justifyContent: "center",
    height: "100vh", background: "#0a0a0f", color: "#888", fontSize: "16px",
  }}>
    Loading…
  </div>
);

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/" element={<GraphPage />} />
          <Route path="/admin" element={<AdminPage />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  </React.StrictMode>
);
