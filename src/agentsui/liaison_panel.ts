// U93 oracle seam. S1 is consumed structurally until its upstream types land.
import type { LiaisonController, LiaisonInput } from "../app/liaison";

export interface LiaisonComposer { setDraft(text: string): void; getDraft(): string }
export interface LiaisonPanelDeps {
  controller: LiaisonController;
  getContext(): LiaisonInput;
  getChatHandle(context: { room: string; task_id: string }): LiaisonComposer | undefined;
  onSend(context: { room: string; task_id: string; text: string }): void | Promise<void>;
  onEscalate?: (context: { room: string; task_id: string; text: string }) => void | Promise<void>;
  onPlan(): void | Promise<void>;
  onMemory(): void | Promise<void>;
  trigger: HTMLElement;
}
export interface LiaisonPanelHandle { refresh(): void; destroy(): void }

const CHIP_TEXT: Readonly<Record<string, string>> = {
  ON_DEVICE: "On device",
  IN_CLOUD: "Cloud",
  LOCAL_SERVER: "Local model",
  REMOTE_PROVIDER: "Network model",
  rules: "Rules",
};
const CHIP_DATA_SOURCE: Readonly<Record<string, string>> = {
  ON_DEVICE: "on-device",
  IN_CLOUD: "cloud",
  LOCAL_SERVER: "local",
  REMOTE_PROVIDER: "remote",
  rules: "rules",
};

function textNode(doc: Document, value: string): Text {
  return doc.createTextNode(value);
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (text !== undefined) node.appendChild(textNode(doc, text));
  return node;
}

export function mountLiaisonPanel(container: HTMLElement, deps: LiaisonPanelDeps): LiaisonPanelHandle {
  const doc = container.ownerDocument;
  let destroyed = false;
  let rendering = false;
  let mounting = true;
  let unsubscribe: (() => void) | undefined;

  const panel = doc.createElement("div");
  panel.className = "liaison-panel";
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "Liaison");
  container.replaceChildren(panel);

  const heading = el(doc, "h2", "Liaison");
  panel.appendChild(heading);

  const stateLine = doc.createElement("p");
  panel.appendChild(stateLine);

  const holdLine = doc.createElement("p");
  panel.appendChild(holdLine);

  const errorLine = doc.createElement("p");
  errorLine.setAttribute("role", "status");
  panel.appendChild(errorLine);
  const report = (error: unknown): void => {
    if (!destroyed) errorLine.replaceChildren(textNode(doc, error instanceof Error ? error.message : "Liaison action failed"));
  };
  const run = (action: () => unknown): void => {
    if (destroyed) return;
    try { void Promise.resolve(action()).then(undefined, report); } catch (error) { report(error); }
  };
  const button = (document: Document, label: string, action: () => unknown): HTMLButtonElement => {
    const node = document.createElement("button");
    node.type = "button"; node.appendChild(textNode(document, label));
    node.addEventListener("click", () => run(action));
    return node;
  };
  const contextMatches = (context: LiaisonInput,
    candidate: Pick<LiaisonInput, "room" | "task_id" | "tier" | "human"> | undefined): boolean =>
    candidate !== undefined && candidate.room === context.room && candidate.task_id === context.task_id && candidate.tier === context.tier
      && candidate.human.id === context.human.id && candidate.human.text === context.human.text;
  const synchronized = (): { context: LiaisonInput; snap: ReturnType<LiaisonController["snapshot"]> } => {
    const context = deps.getContext();
    deps.controller.setContext(context);
    const current = deps.controller.snapshot();
    // Check independently of setContext: injected controllers may retain old results.
    const compatible = contextMatches(context, current.input)
      && (current.identity === undefined || contextMatches(context, current.identity));
    const snap = { ...current };
    if (!compatible) delete snap.result;
    return { context, snap };
  };

  // Compare against the composer observed when this request began, including
  // edits made while inference was pending. A later result cannot reset it.
  type Snapshot = ReturnType<LiaisonController["snapshot"]>;
  interface ComposerBaseline { scope: object | undefined; room: string; task_id: string; tier: LiaisonInput["tier"];
    human: Readonly<LiaisonInput["human"]>; handle: LiaisonComposer; text: string }
  let composerBaseline: ComposerBaseline | undefined;
  let acceptedDraft: { result: Extract<NonNullable<Snapshot["result"]>, { ok: true }>; input: LiaisonInput;
    generation: number | undefined; baseline: ComposerBaseline | undefined } | undefined;
  const resultScope = (snap: Snapshot): object | undefined => snap.identity ?? snap.result;
  const rememberComposer = (context: LiaisonInput, snap: Snapshot, handle: LiaisonComposer): void => {
    // A handle appearing after inference cannot authorize replacing its text.
    if (!mounting && snap.state !== "starting") return;
    if (composerBaseline === undefined || composerBaseline.scope !== resultScope(snap)
      || !contextMatches(context, composerBaseline) || composerBaseline.handle !== handle) {
      composerBaseline = { scope: resultScope(snap), room: context.room, task_id: context.task_id, tier: context.tier,
        human: { ...context.human }, handle, text: handle.getDraft() };
    }
  };
  const composerChanged = (context: LiaisonInput, handle: LiaisonComposer, baseline: ComposerBaseline | undefined): boolean =>
    baseline === undefined || !contextMatches(context, baseline) || baseline.handle !== handle || handle.getDraft() !== baseline.text;
  // A failed transformation does not erase an earlier accepted draft. Keep its
  // original editor baseline and discard it on context or binding changes.
  const usableDraft = (context: LiaisonInput, snap: Snapshot): typeof acceptedDraft => {
    if (acceptedDraft === undefined) return undefined;
    const matches = contextMatches(context, acceptedDraft.input) && contextMatches(context, snap.input)
      && acceptedDraft.generation === snap.identity?.generation;
    if (!matches) { acceptedDraft = undefined; return undefined; }
    if (snap.result === undefined) {
      if (snap.state !== "starting" && snap.state !== "paused") acceptedDraft = undefined;
      return undefined;
    }
    return snap.result.ok || snap.result.code === "SCHEMA_REJECT" ? acceptedDraft : undefined;
  };

  const humanSection = doc.createElement("section");
  humanSection.setAttribute("aria-label", "Original human draft");
  const humanLabel = el(doc, "h3", "Original human draft");
  const humanBody = doc.createElement("p");
  humanSection.append(humanLabel, humanBody);
  panel.appendChild(humanSection);

  const outputSection = doc.createElement("section");
  outputSection.setAttribute("aria-label", "Liaison output");
  const outputLabel = el(doc, "h3", "Liaison output");
  const outputBody = doc.createElement("p");
  outputSection.append(outputLabel, outputBody);
  panel.appendChild(outputSection);

  const attributionSection = doc.createElement("section");
  attributionSection.setAttribute("aria-label", "Liaison attribution");
  panel.appendChild(attributionSection);

  const controls = doc.createElement("div");
  panel.appendChild(controls);

  const draftBtn = button(doc, "Draft", () => {
    if (destroyed) return;
    return deps.controller.generate(deps.getContext(), "draft");
  });
  const summaryBtn = button(doc, "Summary", () => {
    if (destroyed) return;
    return deps.controller.generate(deps.getContext(), "summary");
  });
  const clarifyBtn = button(doc, "Clarify", () => {
    if (destroyed) return;
    return deps.controller.generate(deps.getContext(), "clarify");
  });
  const useDraftBtn = button(doc, "Use draft", () => {
    if (destroyed) return;
    const { context, snap } = synchronized();
    const draft = usableDraft(context, snap);
    if (draft === undefined) return;
    const handle = deps.getChatHandle({ room: context.room, task_id: context.task_id });
    if (handle === undefined) return;
    if (composerChanged(context, handle, draft.baseline)) {
      report(new Error("Executor composer changed; generate a new liaison draft before replacing it")); return;
    }
    const result = handle.setDraft(draft.result.output.text);
    if (draft.baseline !== undefined) draft.baseline.text = draft.result.output.text;
    return result;
  });
  const sendBtn = button(doc, "Send", () => {
    if (destroyed) return;
    const context = deps.getContext();
    const handle = deps.getChatHandle({ room: context.room, task_id: context.task_id });
    if (handle === undefined) return;
    const text = handle.getDraft();
    if (typeof text !== "string" || text === "") return;
    return deps.onSend({ room: context.room, task_id: context.task_id, text });
  });
  const pauseBtn = button(doc, "Pause", () => {
    if (destroyed) return;
    return deps.controller.pause();
  });
  const resumeBtn = button(doc, "Resume", () => {
    if (destroyed) return;
    return deps.controller.resume();
  });
  const escalateBtn = button(doc, "Escalate", () => {
    if (destroyed) return;
    if (deps.onEscalate === undefined) return;
    const { context, snap } = synchronized();
    const handle = deps.getChatHandle({ room: context.room, task_id: context.task_id });
    const draft = usableDraft(context, snap);
    const text = draft !== undefined && handle !== undefined && composerChanged(context, handle, draft.baseline) ? handle.getDraft()
      : draft !== undefined ? draft.result.output.text : handle?.getDraft() || context.human.text;
    return deps.onEscalate({ room: context.room, task_id: context.task_id, text });
  });
  const planBtn = button(doc, "Plan", () => {
    if (destroyed) return;
    return deps.onPlan();
  });
  const memoryBtn = button(doc, "Memory", () => {
    if (destroyed) return;
    return deps.onMemory();
  });
  const closeBtn = button(doc, "Close", () => {
    if (destroyed) return;
    deps.trigger.focus();
  });
  controls.append(draftBtn, summaryBtn, clarifyBtn, useDraftBtn, sendBtn, pauseBtn, resumeBtn, escalateBtn, planBtn, memoryBtn, closeBtn);

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      run(() => deps.trigger.focus());
    }
  };
  container.addEventListener("keydown", onKeydown);

  const teardown = (action: () => unknown): void => {
    try { void Promise.resolve(action()).then(undefined, () => {}); } catch { /* continue cleanup */ }
  };
  // pagehide and explicit destruction use exactly the same idempotent cleanup.
  const cleanup = (): void => {
    if (destroyed) return;
    destroyed = true;
    teardown(() => unsubscribe?.());
    container.removeEventListener("keydown", onKeydown);
    globalThis.removeEventListener("pagehide", cleanup);
    teardown(() => deps.controller.destroy());
  };
  globalThis.addEventListener("pagehide", cleanup);

  const render = (): void => {
    if (destroyed || rendering) return;
    rendering = true;
    try {
      const { context, snap } = synchronized();
      let handle: LiaisonComposer | undefined;
      try { handle = deps.getChatHandle({ room: context.room, task_id: context.task_id }); } catch { handle = undefined; }
      if (handle !== undefined) rememberComposer(context, snap, handle);
      if (snap.result?.ok === true && snap.result !== acceptedDraft?.result && snap.input !== undefined) {
        // Keep the generating input; refreshing must never re-stamp an old result.
        acceptedDraft = { result: snap.result, input: { ...snap.input, human: { ...snap.input.human } },
          generation: snap.identity?.generation, baseline: composerBaseline };
      }
      const draft = usableDraft(context, snap);
      stateLine.replaceChildren(textNode(doc, `State: ${snap.state} — ${snap.reason}`));
      humanBody.replaceChildren(textNode(doc, context.human.text));
      if (snap.result !== undefined && snap.result.ok === true) {
        outputBody.replaceChildren(textNode(doc, snap.result.output.text));
      } else if (snap.result !== undefined) {
        const prior = draft === undefined ? "" : `Previous accepted liaison output: ${draft.result.output.text}\n`;
        outputBody.replaceChildren(textNode(doc, `${prior}${snap.result.reason ?? snap.result.code}`));
      } else {
        outputBody.replaceChildren(textNode(doc, "No liaison output yet"));
      }
      attributionSection.replaceChildren();
      if (draft !== undefined) {
        const attribution = draft.result.attribution;
        const sourceKey = String(attribution.source);
        const chipText = CHIP_TEXT[sourceKey] ?? sourceKey;
        const dataSource = CHIP_DATA_SOURCE[sourceKey] ?? sourceKey;
        const chip = doc.createElement("span");
        chip.className = "source";
        chip.setAttribute("data-source", dataSource);
        chip.appendChild(textNode(doc, chipText));
        const providerLine = doc.createElement("p");
        providerLine.appendChild(textNode(doc, attribution.providerId));
        const modelLine = doc.createElement("p");
        modelLine.appendChild(
          textNode(doc, attribution.modelLabel !== undefined && attribution.modelLabel !== "" ? attribution.modelLabel : "AUSENTE"),
        );
        attributionSection.append(chip, providerLine, modelLine);
        if (typeof attribution.admission === "string" && attribution.admission !== "") {
          const admissionLine = doc.createElement("p");
          admissionLine.appendChild(textNode(doc, attribution.admission));
          attributionSection.appendChild(admissionLine);
        }
        if (typeof attribution.reason === "string" && attribution.reason !== "") {
          const reasonLine = doc.createElement("p");
          reasonLine.appendChild(textNode(doc, attribution.reason));
          attributionSection.appendChild(reasonLine);
        }
      }
      if (handle === undefined) {
        holdLine.replaceChildren(textNode(doc, "Liaison HOLD: chat handle unavailable"));
      } else {
        holdLine.replaceChildren();
      }
      const usable = draft !== undefined;
      useDraftBtn.disabled = !(usable && handle !== undefined);
      sendBtn.disabled = handle === undefined;
      escalateBtn.disabled = deps.onEscalate === undefined;
      resumeBtn.hidden = snap.state !== "paused";
      pauseBtn.hidden = snap.state === "paused";
    } catch (error) {
      outputBody.replaceChildren(); attributionSection.replaceChildren(); useDraftBtn.disabled = true;
      report(error);
    } finally { rendering = false; }
  };

  try { unsubscribe = deps.controller.subscribe(render); } catch (error) { report(error); }
  render();
  mounting = false;

  return { refresh: render, destroy: cleanup };
}
