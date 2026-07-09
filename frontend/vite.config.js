import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import wails from "@wailsio/runtime/plugins/vite";
export default defineConfig({
    // Bind the dev server to 127.0.0.1 (IPv4). Wails' dev asset proxy dials
    // tcp4 127.0.0.1:<port>; the default `localhost` host resolves to IPv6 (::1)
    // on Windows, which the proxy can't reach (HTTP 502 in the webview).
    server: {
        host: "127.0.0.1",
        port: Number(process.env.WAILS_VITE_PORT) || 9245,
        strictPort: true,
    },
    plugins: [react(), tailwindcss(), wails("./bindings")],
    resolve: {
        alias: {
            "@": resolve(__dirname, "./src"),
        },
    },
});
