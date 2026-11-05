import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import wails from "@wailsio/runtime/plugins/vite";
export default defineConfig(({ mode }) => {
    const web = mode === "web";
    // Design preview: the desktop UI in a plain browser, every Go binding
    // answered from fixtures (src/lib/preview-runtime.ts).
    const preview = mode === "preview";
    return {
        // Bind the dev server to 127.0.0.1 (IPv4). Wails' dev asset proxy dials
        // tcp4 127.0.0.1:<port>; the default `localhost` host resolves to IPv6 (::1)
        // on Windows, which the proxy can't reach (HTTP 502 in the webview).
        server: {
            host: "127.0.0.1",
            port: Number(process.env.WAILS_VITE_PORT) || 9245,
            strictPort: true,
        },
        plugins: web
            ? [
                react(),
                tailwindcss(),
                // The browser version's product name, in the tab and in link previews.
                { name: "web-title", transformIndexHtml: (html) => html.replace("<title>Imference Desktop</title>", "<title>Imference Web</title>") },
            ]
            : preview
                ? [react(), tailwindcss()]
                : [react(), tailwindcss(), wails("./bindings")],
        resolve: {
            alias: [
                { find: "@", replacement: resolve(__dirname, "./src") },
                // The runtime's pure-JS helpers (Create, CancellablePromise), reused by
                // the web runtime shim.
                { find: "wails-runtime-dist", replacement: resolve(__dirname, "node_modules/@wailsio/runtime/dist") },
                // Web build: the generated bindings and wails-bridge.ts talk to the Go web
                // server (src/lib/web-runtime.ts) instead of the Wails webview.
                ...(web ? [{ find: /^@wailsio\/runtime$/, replacement: resolve(__dirname, "src/lib/web-runtime.ts") }] : []),
                ...(preview ? [{ find: /^@wailsio\/runtime$/, replacement: resolve(__dirname, "src/lib/preview-runtime.ts") }] : []),
            ],
        },
        // Preview: never pre-bundle the real runtime past the alias.
        optimizeDeps: preview ? { exclude: ["@wailsio/runtime"] } : undefined,
        // npm run build:web -> dist-web/, embedded by the Go web build (web_main.go).
        // Relative asset URLs: the same build is served at "/" or under "/app/".
        base: web ? "./" : undefined,
        // Design preview build (visual regression): never into dist/, which the
        // desktop binary embeds.
        build: web
            ? { outDir: "dist-web", emptyOutDir: true }
            : preview
                ? { outDir: "dist-preview", emptyOutDir: true }
                : undefined,
    };
});
