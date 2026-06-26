import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// System-following dark mode. Toggling `.dark` on <html> remaps the CSS color
// tokens defined in index.css, so the whole app follows the OS appearance and
// stays in sync if the user flips it. (Class toggle rather than a CSS media
// query so it can be forced programmatically, e.g. in screenshots/tests.)
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = (dark: boolean) => document.documentElement.classList.toggle("dark", dark);
applyTheme(prefersDark.matches);
prefersDark.addEventListener("change", (e) => applyTheme(e.matches));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
