// U39 route table: frozen ROUTE_TABLE, validateTable, canonical tableHash.
import { createHash } from "node:crypto";
import type { RouteRule, RouteTable } from "./types";
import { ROUTE_TARGETS } from "./types";

function rule(id: string, target: RouteRule["target"], terms: string[]): RouteRule {
  return Object.freeze({ id, target, terms: [...terms] });
}

const RULES: RouteRule[] = [
  rule("r.ask", "ask_agent", ["ask", "pregunta", "preguntar", "consultar", "consulta", "question", "revisar", "revisa", "revision"]),
  rule("r.plan", "plan_change", ["cambio", "cambiar", "planificacion", "planificar", "replanificar", "replan", "change", "changed", "reorder", "reordenar", "revise", "drop", "step", "steps", "two", "add", "test", "new", "nuevo", "scope", "alcance", "paso", "pasos", "anadir", "pruebas"]),
  rule("r.status", "status_query", ["como", "va", "estado", "status", "progreso", "progress", "build", "proyecto", "project", "tarea", "task", "implementacion", "implementation", "punto", "point", "actual", "current", "hasta", "ahora", "update", "how", "going", "where"]),
  rule("r.escalate", "escalate", ["bloqueado", "blocked", "necesito", "necesita", "need", "needs", "aprobacion", "approval", "usuario", "user", "humano", "human", "decida", "decision", "urgente", "urgent", "ayuda", "escalar", "escalate", "responsable", "owner", "continuar", "continue", "confirmacion", "confirmation", "cannot", "puedo", "sin", "without", "estoy"]),
  rule("r.focus", "focus_capsule", ["enfoca", "focus", "capsula", "capsule", "agente", "agent", "muestra", "show", "abre", "bring", "resalta", "highlight", "primer", "plano", "front", "ponla", "enfocar", "abrir", "resaltar"]),
  rule("r.handoff", "handoff", ["traspaso", "handoff", "handing", "passing", "transfer", "entrega", "paso", "revisor", "reviewer", "trabajo", "work", "siguiente", "next", "contexto", "context", "full", "hago", "otro", "other", "desde", "aqui", "continua", "over", "off"]),
  rule("r.ack", "ack_noise", ["ok", "gracias", "thanks", "thank", "vale", "recibido", "perfecto", "entendido", "genial", "got", "roger", "noted", "sounds", "good"]),
];

export const ROUTE_TABLE: RouteTable = Object.freeze({
  version: 1,
  rules: Object.freeze(RULES) as readonly RouteRule[],
  bilingual: Object.freeze({
    cambio: "change",
    estado: "status",
    progreso: "progress",
    capsula: "capsule",
    traspaso: "handoff",
    gracias: "thanks",
    agente: "agent",
    tarea: "task",
  }),
});

const TARGET_SET: Set<string> = new Set(ROUTE_TARGETS as readonly string[]);

export function validateTable(t: RouteTable): string[] {
  const errs: string[] = [];
  try {
    if (t === null || typeof t !== "object") return ["table must be an object"];
    const rules = (t as { rules?: unknown }).rules;
    if (!Array.isArray(rules)) return ["rules must be an array"];
    const seen = new Set<string>();
    for (const r of rules as unknown[]) {
      if (r === null || typeof r !== "object") {
        errs.push("rule must be an object");
        continue;
      }
      const id = (r as { id?: unknown }).id;
      const target = (r as { target?: unknown }).target;
      const terms = (r as { terms?: unknown }).terms;
      if (typeof id !== "string" || id === "") {
        errs.push("empty id");
      } else if (seen.has(id)) {
        errs.push(`duplicate id: ${id}`);
      } else {
        seen.add(id);
      }
      if (typeof target !== "string" || !TARGET_SET.has(target)) {
        errs.push(`unknown target: ${String(target)}`);
      }
      if (!Array.isArray(terms) || terms.length === 0) {
        errs.push(`empty terms for rule: ${String(id)}`);
      } else {
        for (const term of terms as unknown[]) {
          if (typeof term !== "string" || term.trim() === "") {
            errs.push(`empty term for rule: ${String(id)}`);
            break;
          }
        }
      }
    }
    return errs;
  } catch {
    return errs.length > 0 ? errs : ["invalid table"];
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonical(v)).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const inner = keys
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",");
    return `{${inner}}`;
  }
  return JSON.stringify(String(value)) ?? "null";
}

const hashCache = new WeakMap<object, string>();

function normalizedForHash(t: RouteTable): unknown {
  if (t === null || typeof t !== "object") return t;
  const rules = (t as { rules?: unknown }).rules;
  if (!Array.isArray(rules)) return t;
  const sortedRules = [...(rules as unknown[])].sort((a, b) => {
    const ca = canonical(a);
    const cb = canonical(b);
    return ca < cb ? -1 : ca > cb ? 1 : 0;
  });
  return { version: (t as { version?: unknown }).version, rules: sortedRules, bilingual: (t as { bilingual?: unknown }).bilingual };
}

export function tableHash(t: RouteTable): string {
  try {
    if (t !== null && typeof t === "object") {
      const cached = hashCache.get(t as object);
      if (cached !== undefined) return cached;
    }
    const hex = createHash("sha256").update(canonical(normalizedForHash(t))).digest("hex");
    if (t !== null && typeof t === "object") {
      hashCache.set(t as object, hex);
    }
    return hex;
  } catch {
    return createHash("sha256").update("U39-invalid").digest("hex");
  }
}
