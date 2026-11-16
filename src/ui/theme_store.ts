export type Theme = "light" | "dark";
const KEY = "tasklight.theme";

export function readTheme(): Theme {
  try {
    return globalThis.localStorage?.getItem(KEY) === "dark" ? "dark" : "light";
  } catch { return "light"; }
}

export function writeTheme(theme: Theme): void {
  try { globalThis.localStorage?.setItem(KEY, theme); } catch { /* switching works with blocked storage */ }
}
