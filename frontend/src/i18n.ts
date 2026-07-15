import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

// Languages the UI ships with. Labels are shown in their own language (the
// convention for language pickers) so they stay readable whatever is active.
// `short` is the compact form for the header toggle.
export const SUPPORTED_LANGUAGES = [
  { code: "en", label: "English", short: "EN" },
  { code: "zh-CN", label: "简体中文", short: "中文" },
] as const;

// The user's explicit choice lives in the webview's localStorage ("" / absent =
// follow the OS language). Kept out of settings.json on purpose: language is a
// pure UI concern and this avoids a Go round-trip before the first render.
const STORAGE_KEY = "imference.language";

// Map a BCP-47 tag to one of our bundles ("" = unsupported). All zh variants
// (zh-Hans, zh-TW, zh-HK…) get zh-CN until dedicated bundles exist.
function resolve(tag: string): string {
  const t = tag.toLowerCase();
  if (t.startsWith("zh")) return "zh-CN";
  if (t.startsWith("en")) return "en";
  return "";
}

/** The persisted explicit choice; "" means "follow the system". */
export function storedLanguage(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Best supported match for the OS/browser language list. */
export function systemLanguage(): string {
  for (const tag of navigator.languages ?? [navigator.language]) {
    const hit = resolve(tag);
    if (hit) return hit;
  }
  return "en";
}

/** Persist a choice ("" = follow system) and switch the live language. */
export function setLanguage(code: string): void {
  try {
    if (code) localStorage.setItem(STORAGE_KEY, code);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage unavailable — the in-memory switch below still applies.
  }
  void i18n.changeLanguage(code || systemLanguage());
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    "zh-CN": { translation: zhCN },
  },
  lng: storedLanguage() || systemLanguage(),
  fallbackLng: "en",
  interpolation: { escapeValue: false }, // React escapes on render
});

// Keep <html lang> in sync (fonts, hyphenation, a11y).
document.documentElement.lang = i18n.language;
i18n.on("languageChanged", (lng) => {
  document.documentElement.lang = lng;
});

export default i18n;
