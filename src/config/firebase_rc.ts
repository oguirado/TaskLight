import {
  activate,
  fetchAndActivate,
  getRemoteConfig,
  getValue,
  onConfigUpdate,
} from "firebase/remote-config";
import type { RemoteConfigPort } from "./types";

export function firebaseRemoteConfigPort(app: import("firebase/app").FirebaseApp): RemoteConfigPort {
  const rc = getRemoteConfig(app);
  return {
    setDefaults(d: Readonly<Record<string, string>>): void {
      rc.defaultConfig = { ...d };
    },
    setMinimumFetchIntervalMillis(ms: number): void {
      rc.settings.minimumFetchIntervalMillis = ms;
    },
    fetchAndActivate(): Promise<boolean> {
      return fetchAndActivate(rc);
    },
    activate(): Promise<boolean> {
      return activate(rc);
    },
    getString(key: string): string {
      return getValue(rc, key).asString();
    },
    onConfigUpdate(o: {
      next(updatedKeys: ReadonlySet<string>): void;
      error(e: unknown): void;
      complete(): void;
    }): () => void {
      return onConfigUpdate(rc, {
        next(configUpdate) {
          let keys: string[];
          try {
            keys = [...configUpdate.getUpdatedKeys()];
          } catch (e) {
            o.error(e);
            return;
          }
          o.next(new Set(keys));
        },
        error(e: unknown) {
          o.error(e);
        },
        complete() {
          o.complete();
        },
      });
    },
  };
}
