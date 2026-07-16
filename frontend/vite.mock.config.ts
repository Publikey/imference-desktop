import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: {
    "@/lib/wails-bridge": "/tmp/claude-0/-home-user-imference-desktop/99988cc7-2e4b-52d3-a6c9-ee0e295f8d9d/scratchpad/mock-bridge.ts",
    "@": path.resolve(__dirname, "src"),
  } },
  server: { port: 5200 },
});
