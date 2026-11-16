import type { AgentChatHandle, AgentChatHandlers, AgentChatVM } from "./types";

const LIMIT = 4096;
const SUGGEST_NOTE = "Drafted by Gemini Nano on this device — review before sending.";
const SOURCE_NOTES: Record<string, string> = {
  device: "Reviewed by Gemini Nano on this device",
  cloud: "Reviewed by Gemini in the cloud",
  rules: "Reviewed by rules",
  local: "Reviewed by your local model",
  remote: "Reviewed by your network model",
};

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}
function asStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function asBool(v: unknown): boolean {
  return v === true;
}
function asStrList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const e of v) if (typeof e === "string") out.push(e);
  return out;
}
function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

function invoke(fn: (() => unknown) | undefined): void {
  try {
    const ret: unknown = fn?.();
    if (ret !== null && (typeof ret === "object" || typeof ret === "function")) {
      const then = (ret as { then?: unknown }).then;
      if (typeof then === "function") {
        (ret as PromiseLike<unknown>).then(undefined, () => {});
      }
    }
  } catch {
    /* handler errors must not break the component (DISP_03) */
  }
}

export function mountAgentChat(
  host: HTMLElement,
  vm: AgentChatVM,
  handlers?: AgentChatHandlers,
): AgentChatHandle {
  let destroyed = false;
  let currentHandlers: AgentChatHandlers | undefined = handlers;
  let sendingNow = false;
  let escalateUsed = false;

  const doc: Document = host.ownerDocument ?? document;
  const el = <T extends HTMLElement>(tag: string, cls: string): T => {
    const e = doc.createElement(tag) as T;
    e.className = cls;
    return e;
  };

  const section = el<HTMLElement>("section", "agent-chat");
  const header = el<HTMLElement>("header", "agent-chat-head");
  const title = el<HTMLHeadingElement>("h2", "agent-chat-title");
  const closeBtn = el<HTMLButtonElement>("button", "agent-chat-close");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close chat");
  closeBtn.textContent = "Close";
  header.append(title, closeBtn);

  const silentBanner = el<HTMLDivElement>("div", "chat-banner");
  silentBanner.setAttribute("data-kind", "silent");
  const silentText = el<HTMLSpanElement>("span", "chat-banner-text");
  const escalateBtn = el<HTMLButtonElement>("button", "chat-escalate");
  escalateBtn.type = "button";
  escalateBtn.textContent = "Notify orchestrator";
  silentBanner.append(silentText, escalateBtn);

  const driftBanner = el<HTMLDivElement>("div", "chat-banner");
  driftBanner.setAttribute("data-kind", "drift");
  const driftReason = el<HTMLSpanElement>("span", "drift-reason");
  const driftAdded = el<HTMLUListElement>("ul", "drift-added");
  const driftRemoved = el<HTMLUListElement>("ul", "drift-removed");
  const driftSource = el<HTMLSpanElement>("span", "drift-source");
  const acceptBtn = el<HTMLButtonElement>("button", "chat-accept-drift");
  acceptBtn.type = "button";
  acceptBtn.textContent = "Accept new plan";

  const log = el<HTMLOListElement>("ol", "agent-chat-log");
  log.setAttribute("role", "log");
  log.setAttribute("aria-live", "polite");

  const form = el<HTMLFormElement>("form", "agent-chat-composer");
  const textarea = el<HTMLTextAreaElement>("textarea", "chat-input");
  const suggestBtn = el<HTMLButtonElement>("button", "chat-suggest");
  suggestBtn.type = "button";
  suggestBtn.textContent = "Suggest with Gemini Nano";
  const sendBtn = el<HTMLButtonElement>("button", "chat-send");
  sendBtn.type = "submit";
  sendBtn.textContent = "Send";
  const counter = el<HTMLSpanElement>("span", "chat-count");
  counter.textContent = "0 / 4096";
  const note = el<HTMLParagraphElement>("p", "chat-suggest-note");
  note.textContent = SUGGEST_NOTE;
  form.append(textarea, suggestBtn, sendBtn, counter);

  const refreshComposer = (): void => {
    const trimmed = textarea.value.trim();
    const bytes = utf8Bytes(trimmed);
    counter.textContent = `${bytes} / ${LIMIT}`;
    if (bytes > LIMIT) counter.setAttribute("data-over", "true");
    else counter.removeAttribute("data-over");
    sendBtn.disabled = trimmed === "" || bytes > LIMIT || sendingNow;
  };

  const trySend = (): void => {
    if (destroyed || sendingNow) return;
    const trimmed = textarea.value.trim();
    if (trimmed === "") return;
    if (utf8Bytes(trimmed) > LIMIT) return;
    textarea.value = "";
    refreshComposer();
    invoke(() => currentHandlers?.onSend?.(trimmed));
  };

  const onSubmit = (e: Event): void => {
    e.preventDefault();
    if (destroyed) return;
    trySend();
  };
  const onInput = (): void => {
    if (destroyed) return;
    refreshComposer();
  };
  const onKeydown = (e: KeyboardEvent): void => {
    if (destroyed) return;
    const k = e.key;
    if (k === "Enter" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      trySend();
      return;
    }
    if ((k === "1" || k === "2" || k === "3" || k === "4") && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      e.stopPropagation();
    }
  };
  const onClose = (): void => {
    if (destroyed) return;
    invoke(() => currentHandlers?.onClose?.());
  };
  const onSuggest = (): void => {
    if (destroyed) return;
    invoke(() => currentHandlers?.onSuggest?.());
  };
  const onEscalate = (): void => {
    if (destroyed) return;
    if (escalateUsed) return;
    escalateUsed = true;
    escalateBtn.disabled = true;
    invoke(() => currentHandlers?.onEscalate?.());
  };
  const onAccept = (): void => {
    if (destroyed) return;
    invoke(() => currentHandlers?.onAcceptDrift?.());
  };

  form.addEventListener("submit", onSubmit);
  textarea.addEventListener("input", onInput);
  textarea.addEventListener("keydown", onKeydown);
  closeBtn.addEventListener("click", onClose);
  suggestBtn.addEventListener("click", onSuggest);
  escalateBtn.addEventListener("click", onEscalate);
  acceptBtn.addEventListener("click", onAccept);

  let silentShown = false;
  let driftShown = false;

  const assemble = (): void => {
    if (header.parentNode !== section) section.prepend(header);
    if (silentShown && silentBanner.parentNode !== section) {
      const ref = driftShown && driftBanner.parentNode === section ? driftBanner : log.parentNode === section ? log : null;
      section.insertBefore(silentBanner, ref);
    } else if (!silentShown && silentBanner.parentNode === section) {
      silentBanner.remove();
    }
    if (driftShown && driftBanner.parentNode !== section) {
      const ref = log.parentNode === section ? log : null;
      section.insertBefore(driftBanner, ref);
    } else if (!driftShown && driftBanner.parentNode === section) {
      driftBanner.remove();
    }
    if (log.parentNode !== section) section.append(log);
    if (form.parentNode !== section) section.append(form);
  };

  const render = (rawVm: unknown): void => {
    const rec = asRecord(rawVm);
    const agent = asStr(rec.agent);
    const room = asStr(rec.room);
    const titleText = asStr(rec.title);
    sendingNow = asBool(rec.sending);
    const silent = asBool(rec.silent);
    const silentFor = typeof rec.silentFor === "string" && rec.silentFor.length > 0 ? rec.silentFor : null;

    const wasAtBottom = log.scrollHeight - log.scrollTop - log.clientHeight <= 1;

    section.setAttribute("data-agent", agent);
    section.setAttribute("data-room", room);
    title.textContent = titleText;
    textarea.setAttribute("aria-label", `Message to ${agent}`);

    if (silent) {
      silentText.textContent =
        silentFor !== null ? `${agent} has been silent for ${silentFor}` : `${agent} is silent`;
      escalateBtn.disabled = escalateUsed;
      silentShown = true;
    } else {
      escalateUsed = false;
      escalateBtn.disabled = false;
      silentShown = false;
    }

    const driftRaw = rec.drift;
    let driftVerdict = "";
    if (typeof driftRaw === "object" && driftRaw !== null) {
      const d = driftRaw as Record<string, unknown>;
      const v = asStr(d.verdict);
      if (v === "drift" || v === "needs_user") {
        driftVerdict = v;
        driftBanner.setAttribute("data-verdict", driftVerdict);
        driftReason.textContent = asStr(d.reason);
        const added = asStrList(d.added);
        const removed = asStrList(d.removed);
        driftAdded.replaceChildren();
        for (const s of added) {
          const li = doc.createElement("li");
          li.textContent = s;
          driftAdded.append(li);
        }
        driftRemoved.replaceChildren();
        for (const s of removed) {
          const li = doc.createElement("li");
          li.textContent = s;
          driftRemoved.append(li);
        }
        const src = asStr(d.source);
        let sourceText = "";
        if (src === "device" || src === "cloud" || src === "rules" || src === "local" || src === "remote") sourceText = SOURCE_NOTES[src] ?? "";
        const parts: Node[] = [driftReason];
        if (added.length > 0) parts.push(driftAdded);
        if (removed.length > 0) parts.push(driftRemoved);
        if (sourceText !== "") {
          driftSource.textContent = sourceText;
          parts.push(driftSource);
        }
        parts.push(acceptBtn);
        driftBanner.replaceChildren(...parts);
        driftShown = true;
      } else {
        driftBanner.removeAttribute("data-verdict");
        driftShown = false;
      }
    } else {
      driftBanner.removeAttribute("data-verdict");
      driftShown = false;
    }

    const msgsRaw: unknown = rec.messages;
    const list: unknown[] = Array.isArray(msgsRaw) ? msgsRaw : [];
    log.replaceChildren();
    for (const m of list) {
      if (typeof m !== "object" || m === null) continue;
      const mr = m as Record<string, unknown>;
      const f0 = asStr(mr.from);
      const from = f0 === "user" || f0 === "agent" || f0 === "nano" ? f0 : "agent";
      const fromLabel = from === "user" ? "You" : from === "nano" ? "Gemini Nano" : asStr(mr.agent);
      const li = doc.createElement("li");
      li.className = "chat-msg";
      li.setAttribute("data-from", from);
      const span = doc.createElement("span");
      span.className = "chat-from";
      span.textContent = fromLabel;
      const p = doc.createElement("p");
      p.className = "chat-text";
      p.textContent = asStr(mr.text);
      const t = doc.createElement("time");
      t.className = "chat-at";
      t.textContent = asStr(mr.at);
      li.append(span, p, t);
      log.append(li);
    }

    const sugg = typeof rec.suggestion === "string" && rec.suggestion.length > 0 ? rec.suggestion : null;
    if (sugg !== null && textarea.value === "") textarea.value = sugg;
    if (sugg !== null) {
      form.append(note);
    } else {
      note.remove();
    }

    assemble();

    if (wasAtBottom) log.scrollTop = log.scrollHeight;
    refreshComposer();
  };

  try {
    render(vm);
  } catch {
    /* never throw on malformed VM */
  }
  host.replaceChildren(section);

  return {
    update(v: AgentChatVM): void {
      if (destroyed) return;
      try {
        render(v);
      } catch {
        /* never throw on malformed VM */
      }
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      form.removeEventListener("submit", onSubmit);
      textarea.removeEventListener("input", onInput);
      textarea.removeEventListener("keydown", onKeydown);
      closeBtn.removeEventListener("click", onClose);
      suggestBtn.removeEventListener("click", onSuggest);
      escalateBtn.removeEventListener("click", onEscalate);
      acceptBtn.removeEventListener("click", onAccept);
      host.replaceChildren();
    },
  };
}
