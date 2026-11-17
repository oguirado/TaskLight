import { isPlaceholderValue, readPublicConfig } from "../tools/firebase_go_live.mjs";

/** Judge only the literal public values; unrelated placeholder constants do not count. */
export function firebaseConfigIsReal(sourceText) {
  try {
    const { config, siteKey } = readPublicConfig(sourceText);
    return ["apiKey", "authDomain", "projectId", "appId"].every(
      (key) => !isPlaceholderValue(config[key])) && !isPlaceholderValue(siteKey);
  } catch {
    return false;
  }
}
