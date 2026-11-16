// U47 rung ladder for OpenAI-compatible endpoints (SPEC_U47 "OpenAI-compatible adapter").
import type { ChatMessage, Rung } from "./types";

const ONE_OBJECT = "Reply with one JSON object only";
const ENUM_TOKEN = /^[a-z][a-z_]*$/;

/**
 * Rung 1: the schema travels in the transport request (response_format); messages are the prompt only.
 * Rung 2: a system message carries JSON.stringify(schema) and the one-object instruction, then the prompt.
 * Rung 3: plain prompt, no schema text.
 * The prompt is passed verbatim. Pure: the schema is only read.
 */
export function toChatMessages(prompt: string, schema: object, rung: Rung): ChatMessage[] {
  const user: ChatMessage = { role: "user", content: prompt };
  if (rung === 2) {
    let schemaText: string;
    try { schemaText = JSON.stringify(schema) ?? "null"; } catch { schemaText = "null"; }
    return [{ role: "system", content: `${ONE_OBJECT}. It must conform to this JSON schema: ${schemaText}` }, user];
  }
  return [user];
}

/**
 * Rung 3 extraction: the trimmed text when it is exactly one JSON value, or a bare enum token
 * (`[a-z][a-z_]*`, the text/x.enum outputs); otherwise null. Never scavenges, never throws.
 */
export function strictParse(text: string): string | null {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (t.length === 0) return null;
  if (ENUM_TOKEN.test(t)) return t;
  try {
    JSON.parse(t);
    return t;
  } catch {
    return null;
  }
}
