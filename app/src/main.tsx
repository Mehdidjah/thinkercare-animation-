import { createRoot } from "react-dom/client";
import Terrain from "./terrain/ui/App";
import { ErrorBoundary } from "./terrain/ui/ErrorBoundary";
import "./styles.css";

const el = document.getElementById("root");
if (el)
  createRoot(el).render(
    <ErrorBoundary>
      <Terrain />
    </ErrorBoundary>,
  );
