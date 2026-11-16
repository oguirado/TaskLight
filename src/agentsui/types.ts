export type DeliveryState =
  | { state: "sending" }
  | { state: "delivered"; event_id: string; lamport: number }
  | { state: "failed"; code: string }
  | { state: "unknown"; code: string };

export interface ChatMessageVM {
  id: string;
  from: "user" | "agent" | "nano";
  agent: string;
  text: string;
  at: string;
  re?: string;
  delivery?: { client_id: string } & DeliveryState;
}

export interface AgentChatVM {
  room: string;
  agent: string;
  title: string;
  messages: readonly ChatMessageVM[];
  silent: boolean;
  silentFor?: string;
  task?: { id: string; assignee: string | null };
  drift?: {
    verdict: "on_track" | "drift" | "needs_user";
    reason: string;
    added: readonly string[];
    removed: readonly string[];
    source: "device" | "cloud" | "local" | "remote" | "rules";
  };
  suggestion?: string;
  suggestNotice?: string;
  sending: boolean;
  /** Suppress delivery announcements while the drawer is closed. */
  deliveryAnnouncements?: boolean;
}

export interface AgentChatHandlers {
  onSend?(text: string): void;
  onRetry?(client_id: string): void;
  onSuggest?(): void;
  onEscalate?(): void;
  onAcceptDrift?(): void;
  onClose?(): void;
}

export interface AgentChatHandle {
  update(vm: AgentChatVM): void;
  destroy(): void;
  setDraft(text: string): void;
  getDraft(): string;
}
