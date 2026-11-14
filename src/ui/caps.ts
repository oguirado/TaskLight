import type { FrameCaps, MotionPort } from "./types";

export function withReducedMotion(
  inner: FrameCaps,
  m: MotionPort,
): FrameCaps & { dispose: () => void } {
  function apply(): void {
    if (m.reduced()) document.documentElement.classList.add("ui-reduced-motion");
    else document.documentElement.classList.remove("ui-reduced-motion");
  }
  apply();
  const off = m.onChange(() => apply());
  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    off();
  }

  const wrapped: FrameCaps & { dispose: () => void } = {
    maxPatchesThisFrame(): number {
      return inner.maxPatchesThisFrame();
    },
    frameJsBudgetMs(): number {
      return inner.frameJsBudgetMs();
    },
    effectsEnabled(): boolean {
      return inner.effectsEnabled() && !m.reduced();
    },
    beginFrame(): void {
      inner.beginFrame();
    },
    endFrame(applied: number, deferred: number): void {
      inner.endFrame(applied, deferred);
    },
    dispose,
  };
  return wrapped;
}
