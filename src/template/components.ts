export const COMPONENTS = ['chip', 'headline', 'text', 'next', 'steps', 'progress', 'badge', 'time'] as const;
export type ComponentId = (typeof COMPONENTS)[number];
export type TemplateField = 'status' | 'attention' | 'headline' | 'summary' | 'next_action'
  | 'steps' | 'progress' | 'inference_source' | 'stale' | 'updated_at';
export const COMPONENT_FIELDS: Readonly<Record<ComponentId, readonly TemplateField[]>> = {
  chip: ['status', 'attention'], headline: ['headline'], text: ['summary'], next: ['next_action'],
  steps: ['steps'], progress: ['progress'], badge: ['inference_source', 'stale'], time: ['updated_at'],
};
