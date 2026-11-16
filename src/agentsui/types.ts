export interface ChatMessageVM {
  id: string;
  from: "user" | "agent" | "nano";
  agent: string;
  text: string;
  at: string;
  re?: string;
}

export interface AgentChatVM {
  room: string;
  agent: string;
  title: string;
  messages: readonly ChatMessageVM[];
  silent: boolean;
  silentFor?: string;
  drift?: {
    verdict: "on_track" | "drift" | "needs_user";
    reason: string;
    added: readonly string[];
    removed: readonly string[];
    source: "device" | "cloud" | "local" | "remote" | "rules";
  };
  suggestion?: string;
  sending: boolean;
}

export interface AgentChatHandlers {
  onSend?(text: string): void;
  onSuggest?(): void;
  onEscalate?(): void;
  onAcceptDrift?(): void;
  onClose?(): void;
}

export interface AgentChatHandle {
  update(vm: AgentChatVM): void;
  destroy(): void;
}
