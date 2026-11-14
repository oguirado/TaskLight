import type { LensId, UserTemplate, UserSlot } from './types';

function makeSlot(id: UserSlot['id'], component: UserSlot['component'], field: UserSlot['field'], label: string, row: number, col: number): UserSlot {
  return { id, component, field, label, row, col };
}

export function defaultTemplate(lens: LensId): UserTemplate {
  if (lens !== 'dev' && lens !== 'study') throw new Error('unknown lens');
  const baseSlots: UserSlot[] = [
    makeSlot('s1', 'chip', 'status', 'Status', 1, 1),
    makeSlot('s2', 'headline', 'headline', 'Title', 1, 2),
    makeSlot('s3', 'text', 'summary', 'Summary', 2, 1),
    makeSlot('s4', 'next', 'next_action', 'Next', 2, 2),
    makeSlot('s5', 'steps', 'steps', 'Steps', 3, 1),
  ];
  if (lens === 'study') {
    baseSlots.push(makeSlot('s6', 'progress', 'progress', 'Progress', 3, 2));
  }
  return {
    v: 1,
    lens_id: lens,
    name: 'Default',
    grid: { cols: 2 },
    tokens: { accent: 'blue', density: 'normal', radius: 'soft', scale: 'md' },
    slots: baseSlots,
  };
}
