import type { AgentChatVM, ChatMessageVM } from "../../../src/agentsui/types";

export const MESSAGES: readonly ChatMessageVM[] = [
  { id: "m1", from: "user", agent: "You", text: "Draft the release notes for v2.", at: "09:12" },
  { id: "m2", from: "agent", agent: "Atlas", text: "Working on it. I will outline the changes first.", at: "09:13", re: "m1" },
  { id: "m3", from: "nano", agent: "Gemini Nano", text: "Suggestion: keep the notes under 200 words.", at: "09:14" },
  { id: "m4", from: "user", agent: "You", text: "Good, include the migration steps.", at: "09:15" },
  { id: "m5", from: "agent", agent: "Atlas", text: "Outline ready.\nSecond line.", at: "09:16" },
];

export const FIXTURE: AgentChatVM = {
  room: "room-7",
  agent: "Atlas",
  title: "Atlas - release notes",
  messages: MESSAGES,
  silent: false,
  sending: false,
};

export const SILENT: AgentChatVM = { ...FIXTURE, silent: true, silentFor: "12 min" };
export const SILENT_NO_FOR: AgentChatVM = { ...FIXTURE, silent: true };

export const DRIFT: AgentChatVM = {
  ...FIXTURE,
  drift: {
    verdict: "drift",
    reason: "The plan now includes publishing to docs.",
    added: ["Add a changelog", "Publish to docs"],
    removed: ["Skip tests"],
    source: "device",
  },
};
export const DRIFT_NEEDS_USER: AgentChatVM = {
  ...FIXTURE,
  drift: { verdict: "needs_user", reason: "Scope changed, a decision is needed.", added: [], removed: ["Ship Friday"], source: "cloud" },
};
export const DRIFT_ON_TRACK: AgentChatVM = {
  ...FIXTURE,
  drift: { verdict: "on_track", reason: "Everything matches the plan.", added: ["Should not show"], removed: [], source: "rules" },
};
export const DRIFT_RULES: AgentChatVM = {
  ...FIXTURE,
  drift: { verdict: "drift", reason: "Rules flagged a change.", added: ["x"], removed: [], source: "rules" },
};

export const HOSTILE_STRINGS = [
  "<img src=x onerror=alert(1)>",
  "<script>window.__pwned=1</script>",
  "\"><svg onload=alert(1)>",
  "</li></ol><b id=\"evil\">bold</b>",
  "&lt;i&gt;entity&lt;/i&gt; &amp; <a href=\"javascript:alert(1)\">x</a>",
] as const;

export const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
};

/** Same shape as `v` with every string replaced by `s` (ids/enums kept). */
export const hostileChat = (s: string): AgentChatVM => ({
  room: s,
  agent: s,
  title: s,
  messages: [
    { id: "h1", from: "user", agent: s, text: s, at: s },
    { id: "h2", from: "agent", agent: s, text: s, at: s, re: s },
    { id: "h3", from: "nano", agent: s, text: s, at: s },
  ],
  silent: true,
  silentFor: s,
  drift: { verdict: "drift", reason: s, added: [s], removed: [s], source: "device" },
  suggestion: s,
  sending: false,
});
export const benignChat = (): AgentChatVM => hostileChat("plain text");
