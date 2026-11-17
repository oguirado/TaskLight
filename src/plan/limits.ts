export const PLAN_LIMITS = Object.freeze({
  PLANS_PER_ROOM_MAX: 1,
  PLAN_TITLE_MAX: 120,        // matches _validate_plan (bridge/room/store.py:72)
  TASKS_MAX: 40,              // T01..T40 (STRATEGY_v9 §3, §4)
  TASK_TITLE_MAX: 120,        // STRATEGY_v9 §4
  TASK_ACCEPT_MAX: 160,       // matches accept cap (bridge/room/store.py:88)
  TASK_DEPS_MAX: 8,           // STRATEGY_v9 §4
  TASK_ESTIMATE_MAX: 32,      // STRATEGY_v9 §4
  MICROS_MIN: 1,              // matches _validate_plan (bridge/room/store.py:75)
  MICROS_MAX: 12,             // T01.M01..M12 (bridge/room/store.py:75)
  MICRO_TEXT_MAX: 80,         // matches _validate_plan (bridge/room/store.py:84)
  MICRO_ACCEPT_MAX: 160,      // matches _validate_plan (bridge/room/store.py:88)
  MICRO_OUTCOME_MAX: 240,     // matches _validate_step (bridge/room/store.py:102)
  MICRO_TOOK_MAX: 32,         // matches _validate_step (bridge/room/store.py:106)
  MICRO_EVIDENCE_MAX: 8,      // matches _validate_evidence (bridge/room/store.py:121)
  DECISION_HISTORY_MAX: 16,
  DECISION_REASON_MAX: 240,
  DECISION_PATH_MAX: 512,
  OP_PAYLOAD_MAX_BYTES: 8192, // 8 KiB [TARGET] (STRATEGY_v9 §4), under FRAME_MAX 65536 (room_relay.py:18)
  TEXT_MAX_BYTES: 4096,       // matches agent_store.ts:27 & store.py:173
  TS_MAX_ABS: 8.64e15,        // matches agent_store.ts:28
  SILENT_AFTER_MS: 600_000,   // matches agent_store.ts:29 & SILENT_AFTER_S=600 (store.py:19)
  TEMPLATE_NAME_MAX: 40,      // matches TPL_LIMITS.NAME_MAX (src/template/limits.ts:2)
  BRIEF_FIELDS_MAX: 8,        // STRATEGY_v9 §3
  PHASES_MAX: 8,              // STRATEGY_v9 §3
  TASK_TYPES_MAX: 12,         // STRATEGY_v9 §3
  MEMORY_SECTIONS_MAX: 12,    // STRATEGY_v9 §3
  MEMORY_CHARS_MAX: 2000,     // STRATEGY_v9 §3
  PROMPT_JSON_MAX: 1500,      // matches TPL_LIMITS.PROMPT_JSON_MAX (src/template/limits.ts:4)
} as const);

export const ID_RE = /^e-[0-9a-f]{16}$/;
export const ROOM_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const AGENT_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;
export const OP_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const TASK_ID_RE = /^T(0[1-9]|[1-3][0-9]|40)$/;
export const MICRO_ID_RE = /^T(0[1-9]|[1-3][0-9]|40)\.M(0[1-9]|1[0-2])$/;
