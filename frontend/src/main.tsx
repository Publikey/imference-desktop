import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ToastProvider } from "./components/ui/toast";
import "./index.css";
// Side effect: initializes i18next (language detection + bundles) before render.
import "./i18n";
import { initTheme } from "./lib/theme";

// Apply the stored theme preference ("system" follows the OS live) before the
// first paint. Toggling `.dark` on <html> remaps the CSS color tokens in
// index.css, so the whole app restyles. The header's theme toggle drives it.
initTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </React.StrictMode>
);
