// Public web config. PLACEHOLDER values until the D-2 Firebase project exists. Never put secrets or debug tokens here.
export const PLACEHOLDER_PREFIX = "PLACEHOLDER_" as const;
export const FIREBASE_PUBLIC_CONFIG: Readonly<Record<string, string>> = {
  apiKey: "PLACEHOLDER_API_KEY",
  authDomain: "PLACEHOLDER_AUTH_DOMAIN",
  projectId: "PLACEHOLDER_PROJECT_ID",
  appId: "PLACEHOLDER_APP_ID",
  storageBucket: "PLACEHOLDER_STORAGE_BUCKET",
  messagingSenderId: "PLACEHOLDER_SENDER_ID",
};
export const RECAPTCHA_SITE_KEY_PUBLIC = "PLACEHOLDER_RECAPTCHA_SITE_KEY";
export const REQUIRED_CONFIG_KEYS: readonly string[] = ["apiKey", "authDomain", "projectId", "appId"];

/** true when any required key is missing/empty, or any present value is empty or a placeholder
 *  (/^(PLACEHOLDER|REPLACE_ME|CHANGEME|TODO)/i, or wrapped in <...>). */
export function isPlaceholderConfig(cfg: Readonly<Record<string, string>>): boolean {
  for (const k of REQUIRED_CONFIG_KEYS) {
    const v = (cfg as Record<string, string | undefined>)[k];
    if (v === undefined) return true;
    if (isPlaceholderValue(v)) return true;
  }
  for (const v of Object.values(cfg)) {
    if (typeof v === "string" && isPlaceholderValue(v)) return true;
  }
  return false;
}
/** same predicate for a single value (used for the reCAPTCHA site key). */
export function isPlaceholderValue(v: string | undefined): boolean {
  if (v === undefined) return true;
  const t = v.trim();
  if (t === "") return true;
  if (/^<.*>$/.test(t)) return true;
  if (/^(PLACEHOLDER|REPLACE_ME|CHANGEME|TODO)/i.test(t)) return true;
  return false;
}
