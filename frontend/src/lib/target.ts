// Build target: "web" for the browser build (npm run build:web), else desktop.
export const isWeb = import.meta.env.MODE === "web";

// Web build: window event fired when the gallery's location changes (a folder
// picked, its access granted again, back to browser storage), so the gallery
// reloads in place. Never a page reload: Chrome on Android drops a folder's
// access on reload, which made "Allow access" come back in a loop.
export const GALLERY_CHANGED_EVENT = "imference:gallery-changed";
