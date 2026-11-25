import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/world.css";
import "./styles/layout.css";
import "./styles/shell.css";
import "./styles/toolcards.css";
import "./styles/ui.css";
import { App } from "./App";

// Demo pública (GitHub Pages): sin servidor, con datos ficticios. Ver src/demo/mock.ts.
if (import.meta.env.VITE_DEMO) (await import("./demo/mock")).instalarDemo();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
