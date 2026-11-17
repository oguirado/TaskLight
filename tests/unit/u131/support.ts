import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "../../..");
export const SCOPED = ["README.md", "docs/MCP.md", "docs/HEADLESS.md", "docs/PLANNING.md",
  "docs/PLANNING_CONTRACT.md", "docs/MODELS.md", "docs/DESKTOP_SETUP.md"] as const;
export type Corpus = Map<string, string>;
export const read = (path: string): string => existsSync(join(ROOT, path)) ? readFileSync(join(ROOT, path), "utf8") : "";

export function corpus(): Corpus {
  const result = new Map<string, string>([["README.md", read("README.md")]]);
  const visit = (path: string): void => {
    if (!existsSync(join(ROOT, path))) return;
    for (const entry of readdirSync(join(ROOT, path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name.endsWith(".md")) result.set(child, read(child));
    }
  };
  visit("docs");
  return result;
}

const scratch: string[] = [];
export function cleanup(): void {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
}

export function probe(name: "discovery" | "gates" | "messaging" | "walkthrough") {
  const path = mkdtempSync(join(HERE, ".scratch-"));
  scratch.push(path);
  for (const part of ["home", "cw", "temp"]) mkdirSync(join(path, part));
  // Instrument the real Python entry points and their children; no backend is replaced.
  // Wall-clock fields are fixed, network attempts are rejected, and sleeps are virtual.
  writeFileSync(join(path, "sitecustomize.py"), [
    "import socket, time",
    "time.time = lambda: 1760000000.0",
    "def forbidden(*args, **kwargs):",
    "    raise AssertionError('Oracle forbids network access')",
    "time.sleep = lambda seconds: None",
    "socket.create_connection = forbidden",
    "socket.socket.connect = forbidden",
    "socket.socket.connect_ex = forbidden",
    "import atexit, hashlib, json, os, re, sys",
    "from pathlib import Path",
    "if os.environ.get('U131_TRACE') and len(sys.argv) == 5 and sys.argv[1] == 'call' and sys.argv[3] == '--json':",
    "    arguments = json.loads(sys.argv[4])",
    "    room = arguments.get('room', '')",
    "    if isinstance(room, str) and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,47}', room):",
    "        journal = Path(os.environ['CW_HOME']) / 'rooms' / room / 'events.jsonl'",
    "        before = journal.read_bytes() if journal.exists() else b''",
    "        def trace_cli():",
    "            after = journal.read_bytes() if journal.exists() else b''",
    "            record = {'name': sys.argv[2], 'args': arguments,",
    "                      'before': hashlib.sha256(before).hexdigest(), 'after': hashlib.sha256(after).hexdigest()}",
    "            with Path(os.environ['U131_TRACE']).open('a', encoding='utf-8') as stream:",
    "                stream.write(json.dumps(record) + '\\n')",
    "        atexit.register(trace_cli)",
    "",
  ].join("\n"));
  const child = spawnSync("python3", [join(HERE, "probe.py"), name], {
    cwd: ROOT, encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024,
    env: { PATH: process.env["PATH"] ?? "", HOME: join(path, "home"), CW_HOME: join(path, "cw"),
      TMPDIR: join(path, "temp"), PYTHONPATH: [path, ROOT].join(":"), PYTHONDONTWRITEBYTECODE: "1",
      PYTHONHASHSEED: "0", PYTHONUTF8: "1", ...(name === "walkthrough" ? { U131_TRACE: join(path, "cli-trace.jsonl") } : {}) },
  });
  expect(child.error, `${name}: bounded subprocess must start`).toBeUndefined();
  expect(child.status, `${name}: ${child.stderr}\n${child.stdout}`).toBe(0);
  return JSON.parse(child.stdout);
}

export function fences(text: string): { info: string; text: string }[] {
  return [...text.matchAll(/^```([^\n]*)\n([\s\S]*?)^```/gm)]
    .map(match => ({ info: match[1] ?? "", text: match[2] ?? "" }));
}

export function plain(text: string): string {
  return text.replace(/^```[^\n]*\n[\s\S]*?^```/gm, "").replace(/[`*]/g, "").replace(/\s+/g, " ");
}

export function totals(docs: Corpus): { file: string; value: number }[] {
  return [...docs].flatMap(([file, text]) => [...text.matchAll(/\b(\d+)\s+(?:(?:MCP|registered|available|exposed|discovered)\s+)*tools\b|\btool\s+(?:count|total)\s*(?:is|:|=)\s*[`*]*(\d+)/gi)]
    .map(match => ({ file, value: Number(match[1] ?? match[2]) })));
}

export function discoveryIssues(docs: Corpus, count: number, protocol: string, version: string): string[] {
  const issues: string[] = [];
  const found = totals(docs);
  if (found.length !== 1 || found[0]?.file !== "docs/MCP.md" || found[0]?.value !== count) {
    issues.push("The unique total in docs/MCP.md must equal live discovery");
  }
  const declarations = [...docs].flatMap(([file, text]) => [...text.matchAll(/protocolVersion[`*\s:"=]*(\d{4}-\d{2}-\d{2})/g)]
    .map(match => ({ file, value: match[1] })));
  if (!declarations.some(item => item.file === "docs/MCP.md")) issues.push("Document the initialized protocol");
  if (declarations.some(item => item.value !== protocol)) issues.push("Stale protocol version");
  const mcp = docs.get("docs/MCP.md") ?? "";
  const documentedVersion = mcp.match(/"name"\s*:\s*"tasklight"\s*,\s*"version"\s*:\s*"([^"]+)"/)?.[1];
  if (documentedVersion !== version) issues.push("Stale server version");
  return issues;
}

export function legacyIssues(docs: Corpus): string[] {
  return SCOPED.filter(path => {
    const text = plain(docs.get(path) ?? "");
    return /\b(?:chat|liaison)\b/i.test(text) && !/\blegacy\b/i.test(text);
  }).map(path => `${path}: retained chat and liaison need legacy labels`);
}

export function trustIssues(docs: Corpus): string[] {
  const text = plain(docs.get("docs/HEADLESS.md") ?? "");
  const issues: string[] = [];
  if (!/caller.asserted/i.test(text) || !/same.user/i.test(text)) issues.push("Retain caller-asserted identity and same-user storage trust");
  if (!/\b(?:not authentication|not authenticated|no authenticated identity|unauthenticated)\b|(?:do(?:es)? not|cannot|never).{0,80}authenticat/i.test(text)) {
    issues.push("Explicitly deny authenticated identity");
  }
  for (const sentence of text.split(/[.!?]/)) {
    if (/\b(?:identity|identities|pins?|hooks?)\b.{0,80}authenticat|authenticat.{0,50}\b(?:identity|identities|agents?)\b/i.test(sentence)
      && !/\b(?:not|no|never|cannot|unauthenticated)\b/i.test(sentence)) issues.push("Authentication claim");
  }
  return issues;
}

export function privacyIssues(docs: Corpus): string[] {
  const text = plain(["README.md", "docs/MODELS.md", "docs/HEADLESS.md"].map(path => docs.get(path) ?? "").join("\n"));
  const issues: string[] = [];
  if (!/Rules summary/.test(text)) issues.push("Unavailable private narration needs labelled Rules summary");
  if (!/private.{0,120}(?:on.device|never.{0,40}(?:cloud|device)|no cloud)|(?:on.device).{0,100}private/i.test(text)) {
    issues.push("Keep private narration on-device");
  }
  if (!/(?:narrat\w*).{0,160}(?:cannot|never|does not|read.only|no room writes).{0,60}(?:mutat|write|room)|(?:read.only|no room writes).{0,80}narrat/i.test(text)) {
    issues.push("Narration cannot mutate the room");
  }
  for (const sentence of text.split(/[.!?]/)) {
    if (/private\s+(?:rooms?|projects?|narration).{0,100}(?:use|allow|fall\s*back|send|switch).{0,60}cloud/i.test(sentence)
      && !/\b(?:not|no|never|cannot|denied|forbid\w*)\b/i.test(sentence)) issues.push("Private-room cloud claim");
  }
  return issues;
}

// The publication policy's sensitive literals are assembled only in memory.
// Never persist them in public tests, fixtures, or mutation copies.
export const forbiddenTokens = [
  [79, 112, 101, 110, 70, 114, 101, 115, 110, 101, 108],
  [111, 112, 101, 110, 115, 110, 101, 108, 108, 47, 49],
  [47, 104, 111, 109, 101, 47], [47, 116, 109, 112, 47],
].map(bytes => String.fromCharCode(...bytes));

export function publicationIssues(docs: Corpus): string[] {
  return [...docs].flatMap(([file, text]) => forbiddenTokens.filter(token => text.includes(token))
    .map(() => `${file}: forbidden publication token`));
}

function anchor(text: string, id: string): boolean {
  const headings = [...text.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)].map(match => (match[1] ?? "")
    .toLowerCase().replace(/[`*]/g, "").replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/g, "-"));
  return headings.includes(decodeURIComponent(id)) || text.includes(`id="${id}"`) || text.includes(`name="${id}"`);
}

export function linkIssues(docs: Corpus): string[] {
  const issues: string[] = [];
  for (const [file, text] of docs) {
    const inline = [...text.matchAll(/!?\[[^\]\n]*\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/g)].map(m => m[1] ?? "");
    const references = [...text.matchAll(/^\[[^\]\n]+\]:\s*<?([^\s>]+)>?/gm)].map(m => m[1] ?? "");
    for (const url of [...inline, ...references]) {
      if (/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith("//")) continue;
      const [path = "", fragment] = url.split("#", 2);
      const target = path ? resolve(ROOT, dirname(file), decodeURIComponent(path.split("?")[0] ?? "")) : resolve(ROOT, file);
      const rel = relative(ROOT, target);
      if (isAbsolute(rel) || rel.startsWith("..") || !existsSync(target)) issues.push(`${file}: broken local link ${url}`);
      else if (fragment && target.endsWith(".md") && !anchor(readFileSync(target, "utf8"), fragment)) issues.push(`${file}: broken anchor ${url}`);
    }
  }
  return issues;
}

export function availabilityIssues(docs: Corpus, registered: ReadonlySet<string>): string[] {
  const issues: string[] = [];
  const optional = ["work_acquire", "work_report", "agent_lifecycle"];
  for (const [file, text] of docs) {
    for (const block of fences(text)) {
      if (!/^(?:sh|bash|shell|python|json)\b/.test(block.info)) continue;
      for (const name of optional.filter(name => !registered.has(name))) {
        if (new RegExp(`(?:call[\\s\\(]+["']?${name}\\b|["']name["']\\s*:\\s*["']${name}["'])`).test(block.text)) {
          issues.push(`${file}: runnable example for unlanded ${name}`);
        }
      }
    }
  }
  return issues;
}

type Schema = { type?: string | string[]; enum?: unknown[]; required?: string[];
  properties?: Record<string, Schema>; additionalProperties?: boolean; items?: Schema;
  pattern?: string; minLength?: number; maxLength?: number; minItems?: number; maxItems?: number;
  minimum?: number; maximum?: number };

// Validate public JSON request examples against discovered descriptors, without
// importing a proposed implementation or duplicating backend ownership rules.
export function schemaIssues(value: unknown, schema: Schema, at = "arguments"): string[] {
  const issues: string[] = [];
  const matches = (type: string): boolean => type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
    : type === "array" ? Array.isArray(value) : type === "integer" ? Number.isInteger(value)
      : type === "null" ? value === null : typeof value === type;
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(matches)) return [`${at}: wrong type`];
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) issues.push(`${at}: outside enum`);
  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) issues.push(`${at}: pattern mismatch`);
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) issues.push(`${at}: too short`);
    if (schema.maxLength !== undefined && length > schema.maxLength) issues.push(`${at}: too long`);
  } else if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) issues.push(`${at}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) issues.push(`${at}: above maximum`);
  } else if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push(`${at}: too few items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push(`${at}: too many items`);
    if (schema.items) value.forEach((item, index) => issues.push(...schemaIssues(item, schema.items!, `${at}[${index}]`)));
  } else if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const field of schema.required ?? []) if (!Object.hasOwn(record, field)) issues.push(`${at}.${field}: missing`);
    for (const [field, entry] of Object.entries(record)) {
      const child = schema.properties?.[field];
      if (child) issues.push(...schemaIssues(entry, child, `${at}.${field}`));
      else if (schema.additionalProperties === false) issues.push(`${at}.${field}: unknown`);
    }
  }
  return issues;
}
