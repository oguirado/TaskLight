// Sync uncertainty notice (U85 M6): shows stale rooms without ever
// granting a dismiss or retry action. Literal text only.
export interface SyncFault {
  room: string;
  fromLamport?: number;
  toLamport?: number;
}

export interface SyncNotice {
  update(faults: readonly SyncFault[]): void;
  element(): HTMLElement | null;
}

export function createSyncNotice(parent: HTMLElement | DocumentFragment): SyncNotice {
  const doc = parent instanceof DocumentFragment ? parent.ownerDocument : parent.ownerDocument;
  const node = doc.createElement("div");
  node.setAttribute("role", "status");
  node.setAttribute("aria-live", "polite");
  let signature = "";
  const render = (faults: readonly SyncFault[]): string => {
    const sorted = [...faults].sort((a, b) => (a.room < b.room ? -1 : a.room > b.room ? 1 : 0));
    const parts = sorted.map((f) => {
      if (typeof f.fromLamport === "number" && typeof f.toLamport === "number") {
        return `${f.room}: excluded Lamport ${String(f.fromLamport)} to ${String(f.toLamport)}`;
      }
      return `${f.room}: replay required`;
    });
    return parts.length === 0 ? "" : `Progress may be outdated — ${parts.join("; ")}.`;
  };
  return {
    update(faults: readonly SyncFault[]): void {
      const text = render(faults);
      if (text === signature) return;
      signature = text;
      node.textContent = text;
      if (text === "" && node.parentNode !== null) {
        node.remove();
      } else if (text !== "" && node.parentNode === null) {
        parent.appendChild(node);
      }
    },
    element(): HTMLElement | null {
      return node.parentNode === null ? null : node;
    },
  };
}
