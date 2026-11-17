import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_KEYS = ["apiKey", "authDomain", "projectId", "storageBucket", "messagingSenderId", "appId"];
const OUTPUTS = [
  "src/app/firebase-config.public.ts", "firebase.json", "hosting/headers.json",
  "extension/manifest.json", "extension/manifest.dev.json", "extension/src/panel/panel.html",
  ".firebaserc", "firebase/remoteconfig.template.json",
];

export function isPlaceholderValue(value) {
  if (typeof value !== "string") return true;
  const text = value.trim();
  return text === "" || /^<.*>$/.test(text) || /^(PLACEHOLDER|REPLACE_ME|CHANGEME|TODO)/i.test(text);
}

function containsSecret(value) {
  if (typeof value === "string") return value.trimStart().startsWith("-----BEGIN");
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) =>
    /^(private_key|client_email|client_secret|refresh_token)$/i.test(key)
    || /debug|token/i.test(key)
    || (key === "type" && item === "service_account")
    || containsSecret(item));
}

function isHostname(value) {
  return typeof value === "string" && value.length <= 253 && value.split(".").every(
    (label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

function isHostingOrigin(value) {
  if (typeof value !== "string" || isPlaceholderValue(value)) return false;
  const match = /^https:\/\/([^\s/?#:@]+)(?::([0-9]+))?$/.exec(value);
  if (!match || !isHostname(match[1])) return false;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

export function validateInputs(config, options = {}) {
  if (containsSecret(config)) return ["Only public web config is accepted; secret or debug/token material is refused."];
  const problems = [];
  const object = config !== null && typeof config === "object" && !Array.isArray(config);
  if (!object) problems.push("config: expected a public web config JSON object");
  const rules = {
    projectId: (v) => /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(v),
    apiKey: (v) => /^AIza[0-9A-Za-z_-]{35}$/.test(v),
    appId: (v) => /^1:[0-9]+:web:[0-9a-f]+$/.test(v),
    authDomain: isHostname,
    messagingSenderId: (v) => /^[0-9]+$/.test(v),
    storageBucket: isHostname,
  };
  if (object) {
    for (const [key, valid] of Object.entries(rules)) {
      const value = config[key];
      if (isPlaceholderValue(value) || !valid(value)) problems.push(`${key}: invalid or placeholder public value`);
    }
    const extrasHavePlaceholder = (value) => typeof value === "string" ? isPlaceholderValue(value)
      : value && typeof value === "object" && Object.values(value).some(extrasHavePlaceholder);
    if (Object.entries(config).some(([key, value]) => !CONFIG_KEYS.includes(key) && extrasHavePlaceholder(value))) {
      problems.push("config: extra fields must not contain placeholder values");
    }
  }
  if (isPlaceholderValue(options.siteKey) || !/^[0-9A-Za-z_-]{20,64}$/.test(options.siteKey)) {
    problems.push("--site-key: expected a public non-placeholder site key");
  }
  if (isPlaceholderValue(options.extId) || !/^[a-p]{32}$/.test(options.extId)) {
    problems.push("--ext-id: expected a Chrome extension id");
  }
  if (options.hostingOrigin !== undefined && !isHostingOrigin(options.hostingOrigin)) {
    problems.push("--hosting-origin: expected an HTTPS origin with a hostname and no path");
  }
  return problems;
}

// Read only literal data, never evaluate the TypeScript source or user input.
// Source coordinates let configuration edits preserve all surrounding bytes.
function token(source, offset) {
  let start = offset;
  while (start < source.length) {
    if (/\s/.test(source[start])) { start++; continue; }
    if (source.startsWith("//", start)) {
      const end = source.indexOf("\n", start + 2);
      start = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith("/*", start)) {
      const end = source.indexOf("*/", start + 2);
      if (end < 0) throw new Error("Unterminated source comment");
      start = end + 2;
      continue;
    }
    break;
  }
  if (start === source.length) return { kind: "end", value: "", start, end: start };
  const quote = source[start];
  if (quote === '"' || quote === "'") {
    let value = "";
    let end = start + 1;
    while (end < source.length) {
      const ch = source[end++];
      if (ch === quote) return { kind: "literal", value, start, end };
      if (ch === "\n" || ch === "\r") break;
      if (ch !== "\\") { value += ch; continue; }
      const escaped = source[end++];
      const escapes = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0", "\\": "\\", "'": "'", '"': '"' };
      if (Object.hasOwn(escapes, escaped)) value += escapes[escaped];
      else if (escaped === "u" || escaped === "x") {
        const count = escaped === "u" ? 4 : 2;
        const hex = source.slice(end, end + count);
        if (!new RegExp(`^[0-9a-f]{${count}}$`, "i").test(hex)) throw new Error("Invalid literal escape");
        value += String.fromCharCode(parseInt(hex, 16));
        end += count;
      } else throw new Error("Unsupported literal escape");
    }
    throw new Error("Unterminated source string");
  }
  const identifier = /^[A-Za-z_$][\w$]*/.exec(source.slice(start));
  if (identifier) return { kind: "identifier", value: identifier[0], start, end: start + identifier[0].length };
  const numeric = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(start));
  if (numeric) return { kind: "literal", value: Number(numeric[0]), start, end: start + numeric[0].length };
  return { kind: "punctuation", value: quote, start, end: start + 1 };
}

function declaration(source, name) {
  let offset = 0;
  let state = 0;
  while (offset < source.length) {
    const current = token(source, offset);
    offset = current.end;
    if (current.kind !== "identifier") { state = 0; continue; }
    if (state === 0 && current.value === "export") state = 1;
    else if (state === 1 && current.value === "const") state = 2;
    else if (state === 2 && current.value === name) {
      let next;
      do {
        next = token(source, offset); offset = next.end;
        if (next.kind === "end" || next.value === ";") throw new Error(`Missing initializer: ${name}`);
      } while (next.value !== "=");
      return token(source, offset);
    } else state = current.value === "export" ? 1 : 0;
  }
  throw new Error(`Missing declaration: ${name}`);
}

function literal(current) {
  if (current.kind === "literal") return current.value;
  if (current.kind === "identifier" && current.value === "true") return true;
  if (current.kind === "identifier" && current.value === "false") return false;
  throw new Error("Expected a string, number or boolean literal");
}

export function readLiteralObject(source, name) {
  let current = declaration(source, name);
  const advance = () => { current = token(source, current.end); };
  const consume = (value) => {
    if (current.value !== value) throw new Error(`Unexpected initializer structure: ${name}`);
    advance();
  };
  if (current.value === "Object") {
    for (const value of ["Object", ".", "freeze", "("]) consume(value);
  }
  consume("{");
  const fields = Object.create(null);
  while (current.value !== "}") {
    if (!["identifier", "literal"].includes(current.kind) || typeof current.value !== "string") {
      throw new Error(`Invalid object key: ${name}`);
    }
    const key = current.value;
    if (Object.hasOwn(fields, key)) throw new Error(`Duplicate object key: ${name}`);
    advance(); consume(":");
    fields[key] = { ...current, value: literal(current) };
    advance();
    if (current.value !== "}") consume(",");
  }
  return fields;
}

export function readPublicConfig(source) {
  const fields = readLiteralObject(source, "FIREBASE_PUBLIC_CONFIG");
  const site = declaration(source, "RECAPTCHA_SITE_KEY_PUBLIC");
  return { config: Object.fromEntries(Object.entries(fields).map(([key, item]) => [key, item.value])), siteKey: literal(site) };
}

function replaceSpans(source, replacements) {
  return replacements.sort((a, b) => b.start - a.start).reduce(
    (text, span) => text.slice(0, span.start) + JSON.stringify(span.value) + text.slice(span.end), source);
}

function rewriteDirective(source, directive, rewrite) {
  if (typeof source !== "string") throw new Error(`Missing CSP: ${directive}`);
  let found = false;
  const result = source.replace(/(^|;)(\s*)([a-z-]+)(\s+)([^;]*)/gi, (all, sep, spaces, name, gap, body) => {
    if (name.toLowerCase() !== directive) return all;
    found = true;
    return sep + spaces + name + gap + rewrite(body);
  });
  if (!found) throw new Error(`Missing CSP directive: ${directive}`);
  return result;
}

const serialize = (value) => JSON.stringify(value, null, 2) + "\n";

// All transformations are pure; callers can inspect the complete plan before writing.
export function planChanges(files, defaults, config, options) {
  const origin = options.hostingOrigin ?? `https://${config.projectId}.web.app`;
  const plan = [];
  const add = (path, after, fields) => plan.push({ path, before: files[path] ?? null, after, fields });
  const publicSource = files[OUTPUTS[0]];
  const values = readLiteralObject(publicSource, "FIREBASE_PUBLIC_CONFIG");
  const site = declaration(publicSource, "RECAPTCHA_SITE_KEY_PUBLIC");
  if (typeof literal(site) !== "string") throw new Error("Expected a literal public site key");
  const replacements = [];
  const publicFields = [];
  for (const key of CONFIG_KEYS) {
    if (!values[key] || typeof values[key].value !== "string") throw new Error(`Missing literal public config field: ${key}`);
    if (values[key].value !== config[key]) {
      replacements.push({ ...values[key], value: config[key] }); publicFields.push(`FIREBASE_PUBLIC_CONFIG.${key}`);
    }
  }
  if (site.value !== options.siteKey) {
    replacements.push({ ...site, value: options.siteKey }); publicFields.push("RECAPTCHA_SITE_KEY_PUBLIC");
  }
  add(OUTPUTS[0], replaceSpans(publicSource, replacements), publicFields);

  for (const path of [OUTPUTS[1], OUTPUTS[2]]) {
    const object = JSON.parse(files[path]);
    const groups = path === OUTPUTS[1] ? object.hosting?.headers : object;
    if (!Array.isArray(groups)) throw new Error(`Missing hosting headers: ${path}`);
    const fields = [];
    let found = false;
    for (const group of groups) {
      if (!Array.isArray(group.headers)) throw new Error(`Invalid hosting headers: ${path}`);
      for (const header of group.headers) {
        if (header.key?.toLowerCase() !== "content-security-policy") continue;
        found = true;
        const before = header.value;
        header.value = rewriteDirective(before, "frame-ancestors", (body) => {
          if (!/chrome-extension:\/\/[^\s;]+/.test(body)) throw new Error("Missing extension frame ancestor");
          return body.replace(/chrome-extension:\/\/[^\s;]+/g, `chrome-extension://${options.extId}`);
        });
        if (before !== header.value) fields.push("Content-Security-Policy.frame-ancestors");
      }
    }
    if (!found) throw new Error(`Missing Content-Security-Policy: ${path}`);
    if (path === OUTPUTS[1]) {
      const remoteconfig = { ...object.remoteconfig, template: OUTPUTS[7] };
      if (JSON.stringify(object.remoteconfig) !== JSON.stringify(remoteconfig)) fields.push("remoteconfig.template");
      object.remoteconfig = remoteconfig;
    }
    add(path, serialize(object), fields);
  }

  const matches = options.hostingOrigin === undefined
    ? [`${origin}/*`, `https://${config.projectId}.firebaseapp.com/*`] : [`${origin}/*`];
  for (const [path, dev] of [[OUTPUTS[3], false], [OUTPUTS[4], true]]) {
    const manifest = JSON.parse(files[path]);
    const fields = [];
    if (!Array.isArray(manifest.externally_connectable?.matches)) throw new Error(`Missing connection matches: ${path}`);
    const nextMatches = [...matches, ...(dev ? ["http://localhost/*"] : [])];
    if (JSON.stringify(manifest.externally_connectable.matches) !== JSON.stringify(nextMatches)) fields.push("externally_connectable.matches");
    manifest.externally_connectable.matches = nextMatches;
    const csp = manifest.content_security_policy;
    if (!csp) throw new Error(`Missing extension CSP: ${path}`);
    const nextCsp = rewriteDirective(csp.extension_pages, "frame-src", () => origin);
    if (nextCsp !== csp.extension_pages) fields.push("content_security_policy.extension_pages.frame-src");
    csp.extension_pages = nextCsp;
    add(path, serialize(manifest), fields);
  }
  let iframeFound = false;
  const panel = files[OUTPUTS[5]].replace(/(<iframe\b[^>]*?\bsrc\s*=\s*)(["'])([^"']*)\2/gi,
    (all, prefix, quote) => { iframeFound = true; return `${prefix}${quote}${origin}/${quote}`; });
  if (!iframeFound) throw new Error("Missing panel iframe src");
  add(OUTPUTS[5], panel, panel === files[OUTPUTS[5]] ? [] : ["iframe.src"]);
  add(OUTPUTS[6], serialize({ projects: { default: config.projectId } }), ["projects.default"]);
  const parameters = Object.fromEntries(Object.entries(defaults).map(([key, value]) => {
    if (!["string", "number", "boolean"].includes(typeof value) || (typeof value === "number" && !Number.isFinite(value))) {
      throw new Error(`Unsupported Remote Config default: ${key}`);
    }
    return [key, { defaultValue: { value: String(value) }, valueType: typeof value === "boolean" ? "BOOLEAN" : typeof value === "number" ? "NUMBER" : "STRING" }];
  }));
  add(OUTPUTS[7], serialize({ parameters }), ["parameters.defaultValue", "parameters.valueType"]);
  return plan;
}

export function nextCommands(config, options) {
  return [
    "node extension/build.mjs --manifest prod",
    `VITE_RECAPTCHA_SITE_KEY='${options.siteKey}' VITE_EXTENSION_ORIGINS='chrome-extension://${options.extId}' npx vite build --mode production --config hosting/vite.config.ts`,
    ...["hosting", "firestore:rules", "remoteconfig"].map((target) => `npx firebase deploy --project '${config.projectId}' --only ${target}`),
  ];
}

function parseArgs(argv) {
  const options = {};
  const problems = [];
  const names = { "--config": "config", "--site-key": "siteKey", "--ext-id": "extId", "--root": "root", "--hosting-origin": "hostingOrigin" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") { options.dryRun = true; continue; }
    if (!Object.hasOwn(names, arg)) { problems.push("Unknown command-line option"); continue; }
    if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) { problems.push(`${arg}: missing value`); continue; }
    if (Object.hasOwn(options, names[arg])) problems.push(`${arg}: duplicate option`);
    options[names[arg]] = argv[++i];
  }
  for (const name of ["config", "siteKey", "extId"]) {
    if (options[name] === undefined) problems.push(`Missing required option: ${name}`);
  }
  return { options, problems };
}

// Refuse links in every output component before reading or changing any target.
function checkedPath(root, relative) {
  let path = root;
  const parts = relative.split("/");
  for (const [i, part] of parts.entries()) {
    path = join(path, part);
    let stat;
    try { stat = lstatSync(path); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error(`Unsafe project path: ${relative}`);
    }
  }
  return path;
}

export function main(argv, io = console) {
  const { options, problems } = parseArgs(argv);
  if (problems.length) { for (const problem of problems) io.error(problem); return 2; }
  let config;
  try { config = JSON.parse(readFileSync(options.config, "utf8")); }
  catch { io.error("--config: could not read a public web config JSON object"); return 2; }
  const invalid = validateInputs(config, options);
  if (invalid.length) { for (const problem of invalid) io.error(problem); return 2; }
  let root;
  let plan;
  try {
    root = realpathSync(options.root ?? fileURLToPath(new URL("../", import.meta.url)));
    const paths = Object.fromEntries([...OUTPUTS, "src/config/keys.ts"].map((path) => [path, checkedPath(root, path)]));
    const files = Object.fromEntries(OUTPUTS.map((path, index) => {
      try { return [path, readFileSync(paths[path], "utf8")]; }
      catch (error) { if (index >= 6 && error.code === "ENOENT") return [path, null]; throw error; }
    }));
    const defaultsSource = readFileSync(paths["src/config/keys.ts"], "utf8");
    const defaults = Object.fromEntries(["CONFIG_DEFAULTS", "PROVIDER_FLAG_DEFAULTS"].flatMap(
      (name) => Object.entries(readLiteralObject(defaultsSource, name)).map(([key, item]) => [key, item.value])));
    plan = planChanges(files, defaults, config, options);
  } catch { io.error("Project validation failed: required files, literal defaults and safe output paths must be present"); return 2; }
  try {
    for (const change of plan) {
      if (change.before === change.after) continue;
      if (!options.dryRun) {
        const path = checkedPath(root, change.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, change.after, "utf8");
      }
      io.log(`${change.path}: ${options.dryRun ? "would change" : "changed"} ${change.fields.join(", ") || "JSON formatting"}`);
    }
  } catch { io.error("Could not write the planned public configuration"); return 2; }
  for (const command of nextCommands(config, options)) io.log(command);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
