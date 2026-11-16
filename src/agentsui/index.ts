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
  const meta = el<HTMLDivElement>("div", "chat-meta");
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
  const suggestNoticeEl = el<HTMLParagraphElement>("p", "chat-suggest-notice");
  form.append(textarea, suggestBtn, sendBtn, counter, meta);

  let blocked = false;
  let lastMessagesFingerprint: string | null = null;
  let lastMessages: readonly unknown[] = [];
  const seenDeliveryStates = new Map<string, string>();
  let lastDeliveryContext: string | null = null;
  let deliveryAnnouncementsEnabled = false;
  // Cover synchronous activation before the controller supplies its next VM.
  const submittedTexts = new Set<string>();

  const pendingLock = (): boolean => {
    const trimmed = textarea.value.trim();
    if (submittedTexts.has(trimmed)) return true;
    let anySending = false;
    for (const m of lastMessages) {
      if (typeof m !== "object" || m === null) continue;
      const mr = m as Record<string, unknown>;
      const del = mr.delivery;
      if (typeof del !== "object" || del === null) continue;
      const d = del as Record<string, unknown>;
      if (d.state !== "sending") continue;
      anySending = true;
      if (asStr(mr.text).trim() === trimmed) return true;
    }
    return sendingNow && !anySending;
  };

  const refreshComposer = (): void => {
    const trimmed = textarea.value.trim();
    const bytes = utf8Bytes(trimmed);
    counter.textContent = `${bytes} / ${LIMIT}`;
    if (bytes > LIMIT) counter.setAttribute("data-over", "true");
    else counter.removeAttribute("data-over");
    sendBtn.disabled = trimmed === "" || bytes > LIMIT || pendingLock() || blocked;
    suggestBtn.disabled = blocked;
  };

  const trySend = (): void => {
    if (destroyed || blocked) return;
    const trimmed = textarea.value.trim();
    if (trimmed === "") return;
    if (utf8Bytes(trimmed) > LIMIT) return;
    if (pendingLock()) return;
    if (sendingNow && !lastMessages.some((m) => {
      if (typeof m !== "object" || m === null) return false;
      const d = (m as Record<string, unknown>).delivery;
      return typeof d === "object" && d !== null && (d as Record<string, unknown>).state === "sending";
    })) return;
    if (typeof currentHandlers?.onSend !== "function") return;
    submittedTexts.add(trimmed);
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
    if (destroyed || blocked) return;
    invoke(() => currentHandlers?.onSuggest?.());
  };
  const onEscalate = (): void => {
    if (destroyed || blocked) return;
    if (escalateUsed) return;
    escalateUsed = true;
    escalateBtn.disabled = true;
    invoke(() => currentHandlers?.onEscalate?.());
  };
  const onAccept = (): void => {
    if (destroyed || blocked) return;
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
    submittedTexts.clear();
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

    const taskRaw = rec.task;
    let taskId: string | null = null;
    let taskAssignee: string | null = null;
    let hasTask = false;
    if (typeof taskRaw === "object" && taskRaw !== null) {
      const trec = taskRaw as Record<string, unknown>;
      const tid = asStr(trec.id);
      if (tid.length > 0) {
        hasTask = true;
        taskId = tid;
        const asg = trec.assignee;
        taskAssignee = typeof asg === "string" && asg.length > 0 ? asg : null;
      }
    }
    blocked = agent === "" || (hasTask && taskAssignee === null);
    if (hasTask) {
      const executorText = taskAssignee ?? "Executor unassigned";
      const roomSpan = doc.createElement("span");
      roomSpan.textContent = room;
      const taskSpan = doc.createElement("span");
      taskSpan.textContent = taskId ?? "";
      const execSpan = doc.createElement("span");
      execSpan.textContent = executorText;
      meta.replaceChildren(roomSpan, taskSpan, execSpan);
    } else {
      meta.replaceChildren();
    }
    acceptBtn.disabled = blocked;
    if (blocked) {
      escalateBtn.disabled = true;
    }

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

    // A task switch or reopening the drawer restores history. Only changes
    // within the same visible conversation should announce delivery status.
    const deliveryContext = JSON.stringify([room, hasTask ? taskId : null, hasTask ? null : agent]);
    const announcementsEnabled = rec.deliveryAnnouncements !== false;
    const restoringDelivery = deliveryContext !== lastDeliveryContext ||
      !deliveryAnnouncementsEnabled || !announcementsEnabled;
    lastDeliveryContext = deliveryContext;
    deliveryAnnouncementsEnabled = announcementsEnabled;

    const msgsRaw: unknown = rec.messages;
    const list: unknown[] = Array.isArray(msgsRaw) ? msgsRaw : [];
    const fingerprint = JSON.stringify([list, hasTask, taskId, taskAssignee, room, agent]);
    const messagesChanged = fingerprint !== lastMessagesFingerprint;
    if (messagesChanged) {
      let hasDelivery = false;
      let hasNewDelivery = false;
      for (const m of list) {
        if (typeof m !== "object" || m === null) continue;
        const del = (m as Record<string, unknown>).delivery;
        if (typeof del !== "object" || del === null) continue;
        const d = del as Record<string, unknown>;
        const cid = asStr(d.client_id);
        const st = asStr(d.state);
        if (cid === "" || st === "") continue;
        hasDelivery = true;
        if (seenDeliveryStates.get(cid) !== st) hasNewDelivery = true;
      }
      const silenced = restoringDelivery || (hasDelivery && !hasNewDelivery);
      if (silenced) log.setAttribute("aria-live", "off");
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
        const del = mr.delivery;
        if (typeof del === "object" && del !== null) {
          const d = del as Record<string, unknown>;
          const cid = asStr(d.client_id);
          const st = asStr(d.state);
          if (cid !== "" && (st === "sending" || st === "delivered" || st === "failed" || st === "unknown")) {
            li.setAttribute("data-client-id", cid);
            li.setAttribute("data-delivery", st);
            const status = doc.createElement("span");
            status.className = "chat-delivery";
            let statusText = "";
            let mismatch: string | null = null;
            if (st === "sending") statusText = "Sending";
            else if (st === "delivered") {
              statusText = `Delivered · ${asStr(d.event_id)} · ${String(d.lamport)}`;
            } else if (st === "failed") {
              statusText = `Failed (${asStr(d.code)})`;
              if (hasTask && taskAssignee !== asStr(mr.agent)) {
                mismatch = taskAssignee === null
                  ? "Retry unavailable: this task is unassigned"
                  : `Retry unavailable: this task is assigned to ${taskAssignee}`;
              }
            } else {
              statusText = `Delivery unknown (${asStr(d.code)})`;
            }
            status.textContent = mismatch !== null ? `${statusText} — ${mismatch}` : statusText;
            li.append(status);
            if (st === "failed") {
              const retry = doc.createElement("button");
              retry.type = "button";
              retry.className = "chat-retry";
              retry.textContent = "Retry";
              retry.disabled = mismatch !== null;
              retry.addEventListener("click", () => {
                if (destroyed || retry.disabled) return;
                invoke(() => currentHandlers?.onRetry?.(cid));
              });
              li.append(retry);
            }
          }
        }
        log.append(li);
      }
      for (const m of list) {
        if (typeof m !== "object" || m === null) continue;
        const del = (m as Record<string, unknown>).delivery;
        if (typeof del !== "object" || del === null) continue;
        const d = del as Record<string, unknown>;
        const cid = asStr(d.client_id);
        const st = asStr(d.state);
        if (cid !== "" && st !== "") seenDeliveryStates.set(cid, st);
      }
      if (silenced) log.setAttribute("aria-live", "polite");
      lastMessagesFingerprint = fingerprint;
    }
    lastMessages = list;

    const sugg = typeof rec.suggestion === "string" && rec.suggestion.length > 0 ? rec.suggestion : null;
    if (sugg !== null && textarea.value === "") textarea.value = sugg;
    if (sugg !== null) {
      form.append(note);
    } else {
      note.remove();
    }
    const notice = typeof rec.suggestNotice === "string" && rec.suggestNotice.length > 0 ? rec.suggestNotice : null;
    if (notice !== null) {
      suggestNoticeEl.textContent = notice;
      form.append(suggestNoticeEl);
    } else {
      suggestNoticeEl.remove();
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
    setDraft(text: string): void {
      if (destroyed) return;
      textarea.value = typeof text === "string" ? text : "";
      refreshComposer();
    },
    getDraft(): string {
      if (destroyed) return "";
      return textarea.value;
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
