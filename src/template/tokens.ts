export const TOKENS = {
  accent: ['slate', 'blue', 'teal', 'green', 'amber', 'rose'],
  density: ['compact', 'normal', 'roomy'],
  radius: ['none', 'soft', 'round'],
  scale: ['sm', 'md', 'lg'],
} as const;
export type TokenName = keyof typeof TOKENS;
export type Tokens = { [K in TokenName]: (typeof TOKENS)[K][number] };

const set = new Set<string>();
for (const v of TOKENS.accent) set.add(`t-accent-${v}`);
for (const v of TOKENS.density) set.add(`t-density-${v}`);
for (const v of TOKENS.radius) set.add(`t-radius-${v}`);
for (const v of TOKENS.scale) set.add(`t-scale-${v}`);
for (let c = 1; c <= 3; c++) set.add(`g-cols-${c}`);
for (let r = 1; r <= 12; r++) for (let c = 1; c <= 3; c++) set.add(`g-r${r}-c${c}`);
export const STYLE_CLASSES: ReadonlySet<string> = set;
