import type { CardLocator, KeyboardNav } from "./types";
import { UI_LIMITS } from "./limits";

export function createKeyboardNav(
  locator: CardLocator,
  onOpen: (id: string) => void,
): KeyboardNav {
  let ids: readonly string[] = [];
  let columns: number = UI_LIMITS.GRID_COLUMNS_MAX;
  let cursor = -1;

  function clampColumns(c: number): number {
    if (!Number.isFinite(c) || c < 1) return 1;
    return Math.min(Math.floor(c), UI_LIMITS.GRID_COLUMNS_MAX);
  }

  function applyTabindex(): void {
    for (let idx = 0; idx < ids.length; idx += 1) {
      const id = ids[idx];
      if (id === undefined) continue;
      const node = locator.nodeOf(id);
      if (node === null) continue;
      node.setAttribute("tabindex", idx === cursor ? "0" : "-1");
    }
  }

  function focusCursor(): void {
    if (cursor < 0 || cursor >= ids.length) return;
    const id = ids[cursor];
    if (id === undefined) return;
    const node = locator.nodeOf(id);
    if (node !== null) node.focus();
  }

  function move(delta: number): void {
    const next = cursor + delta;
    if (next < 0 || next >= ids.length) return;
    cursor = next;
    applyTabindex();
    focusCursor();
  }

  function jump(index: number): void {
    if (index < 0 || index >= ids.length) return;
    cursor = index;
    applyTabindex();
    focusCursor();
  }

  function focusedId(): string | null {
    if (cursor < 0 || cursor >= ids.length) return null;
    const id = ids[cursor];
    return id ?? null;
  }

  function setOrder(next: readonly string[], nextColumns: number): void {
    const previous = focusedId();
    ids = [...next];
    columns = clampColumns(nextColumns);
    if (ids.length === 0) {
      cursor = -1;
      return;
    }
    if (previous !== null) {
      const at = ids.indexOf(previous);
      if (at >= 0) {
        cursor = at;
      } else if (cursor >= 0) {
        cursor = Math.min(cursor, ids.length - 1);
      } else {
        cursor = 0;
      }
    } else {
      cursor = 0;
    }
    applyTabindex();
    focusCursor();
  }

  function handleKey(key: string): void {
    if (ids.length === 0) return;
    switch (key) {
      case "ArrowRight":
        move(1);
        break;
      case "ArrowLeft":
        move(-1);
        break;
      case "ArrowDown":
        move(columns);
        break;
      case "ArrowUp":
        move(-columns);
        break;
      case "Home":
        jump(0);
        break;
      case "End":
        jump(ids.length - 1);
        break;
      case "Enter": {
        const id = focusedId();
        if (id !== null) onOpen(id);
        break;
      }
      default:
        break;
    }
  }

  return { setOrder, handleKey, focused: focusedId };
}
