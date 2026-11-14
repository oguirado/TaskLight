import type { UserTemplate } from './types';
import { getLens } from '../lens';

// ---- lens resolution (B3/B5/B11) ----
// Read the lens contract from U25 getLens. Only a descriptor that actually
// describes a template (matching lens_id, array template) resolves: its
// bindings are the allowed fields and its template_hash feeds the hash.
// A missing, mismatched, or template-less descriptor is unresolved
// (fail closed, DISP_03). No hardcoded permissions or hash substitute.

export interface ResolvedLens {
  resolved: boolean;
  strict: boolean;
  templateHash: string | null;
  allowedFields: readonly string[] | null;
}

const UNRESOLVED: ResolvedLens = { resolved: false, strict: false, templateHash: null, allowedFields: null };

export function resolveLens(lensId: string): ResolvedLens {
  let lens: unknown;
  try {
    lens = getLens(lensId as never);
  } catch {
    return UNRESOLVED;
  }
  if (lens === null || lens === undefined || typeof lens !== 'object') return UNRESOLVED;
  try {
    const rec = lens as Record<string, unknown>;
    if (rec.lens_id !== lensId) return UNRESOLVED;
    if (!Array.isArray(rec.template)) return UNRESOLVED;
    const fields: string[] = [];
    for (const b of rec.template as unknown[]) {
      if (b !== null && typeof b === 'object') {
        const f = (b as Record<string, unknown>).field;
        if (typeof f === 'string') fields.push(f);
      }
    }
    const h = rec.template_hash;
    return {
      resolved: true,
      strict: true,
      templateHash: typeof h === 'string' && h.length > 0 ? h : null,
      allowedFields: fields,
    };
  } catch {
    return UNRESOLVED;
  }
}

// Deterministic sentinel used when the lens provides no usable template_hash.
// Never equal to a lens_id, so it cannot pose as the legacy fallback.
const NO_LENS_HASH = 'unknown';

function lensHashFor(lensId: string): string {
  const r = resolveLens(lensId);
  if (r.resolved && r.templateHash !== null) return r.templateHash;
  return NO_LENS_HASH;
}

// ---- canonical JSON (B1 total, B11) ----
// Descriptor-based walk: never invokes getters, never recurses past a depth
// cap, treats cycles/accessors/non-JSON values as null. Deterministic for
// every input, including revoked proxies and hostile traps.

const MAX_DEPTH = 128;

function isArrayIndex(k: string): boolean {
  if (!/^(0|[1-9]\d*)$/.test(k)) return false;
  const n = Number(k);
  return Number.isSafeInteger(n) && n < 4294967295;
}

function canon(v: unknown, path: string, seen: Set<object>, depth: number): string {
  if (depth > MAX_DEPTH) return 'null';
  try {
    if (v === null || v === undefined) return 'null';
    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') return JSON.stringify(v) as string;
    if (t !== 'object') return 'null'; // function, symbol, bigint
    const obj = v as object;
    if (seen.has(obj)) return 'null';
    if (Array.isArray(obj)) {
      seen.add(obj);
      try {
        const descs = Object.getOwnPropertyDescriptors(obj) as Record<string, PropertyDescriptor>;
        const lenD = descs.length;
        const len = lenD && typeof lenD.value === 'number' ? (lenD.value as number) : 0;
        const parts: string[] = [];
        for (let i = 0; i < len; i++) {
          const d = descs[String(i)];
          if (!d || d.get !== undefined || d.set !== undefined) {
            parts.push('null');
          } else {
            parts.push(canon(d.value, `${path}[${i}]`, seen, depth + 1));
          }
        }
        return `[${parts.join(',')}]`;
      } finally {
        seen.delete(obj);
      }
    }
    // plain or exotic object: sorted enumerable own data properties
    seen.add(obj);
    try {
      const descs = Object.getOwnPropertyDescriptors(obj) as Record<string, PropertyDescriptor>;
      const keys = Object.keys(descs).sort();
      const parts: string[] = [];
      for (const k of keys) {
        const d = descs[k]!;
        const child = d.get !== undefined || d.set !== undefined ? 'null' : canon(d.value, path ? `${path}.${k}` : k, seen, depth + 1);
        parts.push(`${JSON.stringify(k)}:${child}`);
      }
      return `{${parts.join(',')}}`;
    } finally {
      seen.delete(obj);
    }
  } catch {
    return 'null';
  }
}

export function canonicalTemplateJson(t: UserTemplate): string {
  try {
    return canon(t, '', new Set(), 0);
  } catch {
    return 'null';
  }
}

function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function readLensId(t: unknown): string {
  if (t === null || typeof t !== 'object') return '';
  try {
    const d = Object.getOwnPropertyDescriptor(t, 'lens_id');
    if (!d || d.get !== undefined || d.set !== undefined) return '';
    return typeof d.value === 'string' ? d.value : '';
  } catch {
    return '';
  }
}

export function templateHash(t: UserTemplate): string {
  try {
    const canonStr = canonicalTemplateJson(t);
    const input = canonStr + '|' + lensHashFor(readLensId(t));
    return fnv1a32(input).toString(16).padStart(8, '0');
  } catch {
    return fnv1a32('null|' + NO_LENS_HASH).toString(16).padStart(8, '0');
  }
}
