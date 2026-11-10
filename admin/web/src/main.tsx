import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/world.css";
import "./styles/layout.css";
import "./styles/shell.css";
import "./styles/toolcards.css";
import "./styles/ui.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
