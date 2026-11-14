import { FIREBASE_PUBLIC_CONFIG } from "./firebase-config.public";
import type { HostEnv } from "./types";
export type ViteEnvLike = Readonly<Record<string, string | boolean | undefined>>;
/** MODE "production" -> prod else dev; VITE_RECAPTCHA_SITE_KEY; VITE_APPCHECK_DEBUG_TOKEN ("true" -> true, ""/absent -> undefined,
 *  else string); VITE_EXTENSION_ORIGINS comma list; VITE_USE_LIMITED_USE_TOKENS "true" -> true (default false);
 *  firebaseConfig = FIREBASE_PUBLIC_CONFIG. No default debug token anywhere. */
export function readHostEnv(raw: ViteEnvLike, origin: string): HostEnv {
  const mode = raw["MODE"] === "production" ? "prod" : "dev";
  const recaptchaSiteKey = raw["VITE_RECAPTCHA_SITE_KEY"];
  const rawTok = raw["VITE_APPCHECK_DEBUG_TOKEN"];
  let debugToken: string | true | undefined;
  if (typeof rawTok === "string" && rawTok.length > 0) {
    debugToken = rawTok === "true" ? true : rawTok;
  }
  const rawOrigins = raw["VITE_EXTENSION_ORIGINS"];
  let extensionOrigins: string[] = [];
  if (typeof rawOrigins === "string" && rawOrigins.trim() !== "") {
    extensionOrigins = rawOrigins
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  const useLimitedUseTokens = raw["VITE_USE_LIMITED_USE_TOKENS"] === "true";
  const env: HostEnv = {
    mode,
    origin,
    firebaseConfig: FIREBASE_PUBLIC_CONFIG,
    extensionOrigins,
    useLimitedUseTokens,
  };
  if (typeof recaptchaSiteKey === "string" && recaptchaSiteKey.length > 0) {
    env.recaptchaSiteKey = recaptchaSiteKey;
  }
  if (debugToken !== undefined) {
    env.debugToken = debugToken;
  }
  return env;
}
export * from "./types";
