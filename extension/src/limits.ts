export const EXT_LIMITS = {
  QUEUE_MAX_EVENTS: 512,
  QUEUE_MAX_CHARS: 4_194_304,
  SEND_MAX_PER_SEC: 40,
  LEASE_MAX: 16,
  HELLO_TIMEOUT_MS: 5000,
  HELLO_MAX_RETRIES: 5,
  THROTTLE_RETRY_MS: 1000,
  INFLIGHT_KEEP: 64,
} as const;
/** Chrome native messaging host->extension body limit (S5 [MEASURED]): exactly 1 MiB. */
export const NATIVE_HOST_TO_EXT_MAX_BYTES = 1_048_576 as const;
