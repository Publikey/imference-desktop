// Build target: "web" for the browser build (npm run build:web), else desktop.
export const isWeb = import.meta.env.MODE === "web";
