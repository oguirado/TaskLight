// U14 pure doc helpers (B7).

export function ridOf(projectId: string, hash32: (s: string) => string): string {
  return "p_" + hash32(projectId);
}

export function didOf(canonical: string, hash32: (s: string) => string): string {
  return "d_" + hash32(canonical);
}

export function canonicalDigest(revVectorRid: Readonly<Record<string, number>>, promptVersion: string): string {
  const parts = Object.keys(revVectorRid)
    .sort()
    .map((k) => `${k}:${String(revVectorRid[k])}`)
    .join(",");
  return `pv=${promptVersion}|${parts}`;
}
