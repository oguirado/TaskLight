// U14 stub: constants are the spec's verbatim values (SPEC_U14 §2); behaviour lives in engine.ts.
export const SYNC_KEYS = {   // = repo/firebase/firestore.rules [MEASURED]
  CAPSULE_FULL: ["rev", "observed_rev", "status", "headline", "summary", "next_action",
    "attention", "inference_source", "updated_at", "writer_uid"],
  CAPSULE_PRIVATE: ["rev", "observed_rev", "status", "attention", "updated_at", "writer_uid"],
  LEDGER: ["on_device", "in_cloud", "fallbacks", "refusals", "schema_rejects"],
  RULES_STATUS: ["running", "waiting_input", "blocked", "failed", "done", "idle"],
} as const;

export const SYNC_LIMITS = {
  NEXT_ACTION_MAX: 120, BRIEF_MAX: 600,                         // rules [MEASURED]
  OUTBOX_MAX: 64, MIN_INTERVAL_MS: 2000, TXN_TIMEOUT_MS: 10000,
  BACKOFF_MIN_MS: 1000, BACKOFF_MAX_MS: 30000,                  // [TARGET]
} as const;
