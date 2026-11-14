import { initializeApp } from "firebase/app";
import type { FirebaseApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider, CustomProvider } from "firebase/app-check";
import {
  getAuth,
  signInAnonymously as firebaseSignInAnonymously,
  onAuthStateChanged as firebaseOnAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
} from "firebase/auth";
import type { Auth, User } from "firebase/auth";
import type { FirebasePorts } from "./types";

/** Sole importer of firebase/app, firebase/app-check, firebase/auth. setDebugFlag writes self.FIREBASE_APPCHECK_DEBUG_TOKEN. */
export function createFirebasePorts(): FirebasePorts {
  return {
    initializeApp(cfg: Readonly<Record<string, string>>): unknown {
      return initializeApp(cfg);
    },
    setDebugFlag(v: string | true): void {
      (globalThis as unknown as Record<string, unknown>)["FIREBASE_APPCHECK_DEBUG_TOKEN"] = v;
    },
    newRecaptchaEnterpriseProvider(siteKey: string): unknown {
      return new ReCaptchaEnterpriseProvider(siteKey);
    },
    newDebugCompatibleProvider(): unknown {
      return new CustomProvider({
        getToken: () =>
          Promise.resolve({
            token: String(
              (globalThis as unknown as Record<string, unknown>)["FIREBASE_APPCHECK_DEBUG_TOKEN"] ?? "debug",
            ),
            expireTimeMillis: Date.now() + 3600000,
          }),
      });
    },
    initializeAppCheck(
      app: unknown,
      opts: { provider: unknown; isTokenAutoRefreshEnabled: boolean },
    ): unknown {
      return initializeAppCheck(app as FirebaseApp, {
        provider: opts.provider as never,
        isTokenAutoRefreshEnabled: opts.isTokenAutoRefreshEnabled,
      });
    },
    getAuth(app: unknown): unknown {
      return getAuth(app as FirebaseApp);
    },
    signInAnonymously(auth: unknown): Promise<{ uid: string }> {
      return firebaseSignInAnonymously(auth as Auth).then((cred) => ({ uid: cred.user.uid }));
    },
    onAuthStateChanged(
      auth: unknown,
      cb: (u: { uid: string; isAnonymous: boolean } | null) => void,
    ): () => void {
      const map = (u: User | null): void => {
        if (u === null) cb(null);
        else cb({ uid: u.uid, isAnonymous: u.isAnonymous });
      };
      return firebaseOnAuthStateChanged(auth as Auth, map);
    },
    signInWithGooglePopup(auth: unknown): Promise<{ uid: string }> {
      const provider = new GoogleAuthProvider();
      return signInWithPopup(auth as Auth, provider).then((cred) => ({ uid: cred.user.uid }));
    },
  };
}
