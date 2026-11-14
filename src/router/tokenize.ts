// U39 tokenizer: NFKD fold, camel/snake split, lowercase, light plural stem.
// Pure, deterministic, never throws on hostile input.
export function tokenize(text: string): string[] {
  if (typeof text !== "string") return [];
  const s = text.length > 10000 ? text.slice(0, 10000) : text;
  // NFKD + strip combining marks (accents, fullwidth, ligatures fold here).
  let folded = s.normalize("NFKD").replace(/\p{M}/gu, "");
  // Split camelCase / PascalCase before lowercasing.
  folded = folded
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  folded = folded.toLowerCase();
  // Split on any non-alphanumeric (snake, kebab, dot, slash, punctuation, spaces).
  const parts = folded.split(/[^a-z0-9]+/);
  const out: string[] = [];
  for (const p of parts) {
    if (p.length === 0) continue;
    out.push(stem(p));
  }
  return out;
}

function stem(tok: string): string {
  // Light plural stem: steps->step, needs->need. Guard ss/us so "status"/"class" survive.
  if (tok.length > 3 && tok.endsWith("s") && !tok.endsWith("ss") && !tok.endsWith("us")) {
    return tok.slice(0, -1);
  }
  return tok;
}
