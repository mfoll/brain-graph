import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { STATIC } from "./staticSite";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// In the built app only (not the static demo, which has no server to wait for): a page that explains how to start the server when it is not running.
if (import.meta.env.PROD && !STATIC && "serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
