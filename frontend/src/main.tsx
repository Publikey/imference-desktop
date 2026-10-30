import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ToastProvider } from "./components/ui/toast";
import { ConfirmProvider } from "./components/ui/confirm";
import { WebPayLayer } from "./components/WebPay";
import "./index.css";
// Side effect: initializes i18next (language detection + bundles) before render.
import "./i18n";
import { initTheme } from "./lib/theme";
import { isWeb } from "./lib/target";

// Apply the stored theme preference ("system" follows the OS live) before the
// first paint. Toggling `.dark` on <html> remaps the CSS color tokens in
// index.css, so the whole app restyles. The header's theme toggle drives it.
initTheme();

// Web version: payments (lib/web-pay.ts). Paid calls go through the payment
// dialog, the wallet signs what the server asks for, and the key this browser
// already knows is restored before the app's first call.
async function startWebPay() {
  const [{ payHooks }, pay, { Events }] = await Promise.all([
    import("./lib/web-runtime"),
    import("./lib/web-pay"),
    import("@wailsio/runtime"),
  ]);
  payHooks.withPayment = pay.withPayment;
  // Restore the key first: the event stream (opened by Events.On) then
  // belongs to the session as it will stay.
  await pay.bootstrapWebPay().catch((e) => console.error("web pay: startup", e));
  Events.On("web:sign", (e: { data: any }) => void pay.handleSignRequest(e.data));
}

async function main() {
  if (isWeb) await startWebPay();
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ToastProvider>
        <ConfirmProvider>
          <App />
          {isWeb && <WebPayLayer />}
        </ConfirmProvider>
      </ToastProvider>
    </React.StrictMode>
  );
}

void main();
