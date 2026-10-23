import React from "react";
import { createRoot } from "react-dom/client";
import { RootApp } from "./original/RootApp";
import { PwaStatus } from "./pwa/PwaStatus";
import { registerPwa } from "./pwa/runtime";
import "./ui/styles.css";
registerPwa();
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PwaStatus />
    <RootApp />
  </React.StrictMode>,
);
