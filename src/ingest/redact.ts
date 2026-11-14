import { INGEST_LIMITS } from "./limits";
import type { RedactClass, RedactResult } from "./types";

function shannonEntropy(run: string): number {
  const counts = new Map<string, number>();
  for (const ch of run) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / run.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function isHighEntropyRun(run: string): boolean {
  if (run.length < INGEST_LIMITS.ENTROPY_MIN_LEN) return false;
  return shannonEntropy(run) >= INGEST_LIMITS.ENTROPY_MIN_BITS_PER_CHAR;
}

function hasHighEntropyRun(text: string): boolean {
  const re = /[A-Za-z0-9+/_=-]{32,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (isHighEntropyRun(m[0])) return true;
  }
  return false;
}

/**
 * B6 class patterns, defined once and shared by `redact` (replace, global) and
 * `hasRedactResidue` (test). Bases carry no `g` flag; `globalOf` adds it.
 * Keep both lists in B6 order.
 */
const PEM_TERMINATED = /-----BEGIN [A-Z0-9 -]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 -]*PRIVATE KEY-----/;
const PEM_UNTERMINATED = /-----BEGIN [A-Z0-9 -]*PRIVATE KEY-----[\s\S]*$/;
/**
 * `Bearer` keyword boundary; the separator and the token itself are parsed
 * by `redactBearer` (depth-aware, like `redactKeyAssign`) because the
 * separator can be escaped whitespace (`\t`) at depth >= 1 and a regex
 * cannot express exact backslash-run closing.
 */
const BEARER_HEAD = /(?<![A-Za-z0-9_])Bearer/i;
/**
 * JWT structure only: `eyJ`-anchored segments, or three long base64url segments
 * at a non-identifier boundary. Short dotted names (`config.db.password`) and
 * email domains (`mail.corp.com`) must not match, or JWT would swallow the
 * KEY_ASSIGN name / EMAIL domain before those classes run.
 */
const JWT = /(?<![A-Za-z0-9_.@-])(?:eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}|[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})(?![A-Za-z0-9_-])/;
/**
 * Quoted values may span lines, contain escaped quotes, or be unterminated
 * (truncated log): they consume to the closing quote or to end of input.
 * Backslash-tolerant so JSON-escaped forms (`{\"password\":\"v\"}`) match.
 * `=>` / `:=` / `=` / `:` all separate name and value. The negative lookahead
 * exempts an already-redacted marker value (B7), but not `<marker><tail>` (R1).
 * `…` terminator: truncation appends it right after a marker, so it counts as
 * a delimiter, but only when nothing follows it.
 */
const KEY_ASSIGN =
  /(\\?["']?[A-Za-z0-9_.-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_.-]*\\?["']?\s*(?:=>|:=|[:=](?![=>]))\s*)(?!(?:\\?\[REDACTED:[A-Z_]+\]|"\[REDACTED:[A-Z_]+\]"|\'\[REDACTED:[A-Z_]+\]')(?:$|[\s,;\}\]]|…(?:$|[\s,;\}\]])))(\\"(?:\\\\|[^"\\])*(?:\\"|$)|"(?:\\[\s\S]|[^"\\])*(?:\\?"|$)|\\'(?:\\\\|[^'\\])*(?:\\'|$)|'(?:\\[\s\S]|[^'\\])*(?:\\?'|$)|`(?:\\[\s\S]|[^`\\])*(?:\\?`|$)|[^\s,;`]+)/i;
/** Userinfo runs to the last `@`; `@` in user/password and empty user still count. */
const URL_CREDS = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s\/]*:[^\s\/]*@/;
const APPCHECK_A = /App ?Check debug token:\s*(?:\\*["'`])?[0-9a-fA-F-]{36}(?:\\*["'`])?/i;
const APPCHECK_B = /(FIREBASE_APPCHECK_DEBUG_TOKEN\s*(?:=>|:=|[:=])\s*(?:\\*["'`])?)[0-9a-fA-F-]{36}/i;
const EMAIL = /[A-Za-z0-9!#$%&'*+/=?^_{|}~.-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const HOME_UNIX = /(\/(?:home|Users)\/)[\p{L}\p{N}._-]+/u;
const HOME_WIN = /([A-Za-z]:[\\/]+Users[\\/]+)[\p{L}\p{N}._-]+/iu;
const ENTROPY = /[A-Za-z0-9+/_=-]{32,}/;

function globalOf(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags + "g");
}

function countBackslashesBefore(s: string, pos: number): number {
  let c = 0;
  let i = pos - 1;
  while (i >= 0 && s[i] === "\\") { c++; i--; }
  return c;
}
function nextIsDelimiter(s: string, quotePos: number): boolean {
  if (quotePos + 1 >= s.length) return true;
  const nc = s[quotePos + 1] as string;
  if (nc === "…") return true;
  if (nc === " " || nc === "\t" || nc === "\n" || nc === "\r") return true;
  if (nc === "," || nc === ";" || nc === "}" || nc === "]" || nc === ")") return true;
  // shell / JSON closers that may follow a quoted value after escape layers
  if (nc === "'" || nc === '"' || nc === "`") {
    // next char is another quote that closes an outer shell / JSON string
    return true;
  }
  if (nc === "\\") {
    // next chars are an escape sequence before a delimiter e.g. \} or \"}
    const two = s.slice(quotePos + 1, quotePos + 6);
    if (/^\\+[}\],;]/.test(two) || /^\\+"[{}\],;]/.test(two) || /^\\$/.test(two)) return true;
    if (/^\\+\}/.test(two)) return true;
    return false;
  }
  return false;
}
/**
 * Finds the closing quote of a quoted token: the first quote with exactly
 * the opener's backslash run, followed by a delimiter. Shell single-quote
 * escaping (`'\''` = close, escaped quote, reopen) is skipped as one 4-char
 * unit -- including when the idiom starts at the opener itself -- so its
 * inner quote never closes the token early.
 */
function findQuotedEnd(input: string, openerPos: number, openBs: number): number {
  const openQuote = input[openerPos] as string;
  let from = openerPos + 1;
  if (openQuote === "'" &&
      input[from] === "\\" && input[from + 1] === "'" && input[from + 2] === "'") {
    from += 3;
  }
  for (let j = from; j < input.length; j++) {
    if (openQuote === "'" &&
        input[j] === "'" && input[j + 1] === "\\" &&
        input[j + 2] === "'" && input[j + 3] === "'") {
      j += 3;
      continue;
    }
    if ((input[j] as string) !== openQuote) continue;
    if (countBackslashesBefore(input, j) !== openBs) continue;
    if (!nextIsDelimiter(input, j)) continue;
    return j;
  }
  return -1;
}

function isMarkerAt(s: string, pos: number): { isMarker: boolean; end: number | undefined } {
  const isDelim = (c: string): boolean =>
    c === " " || c === "\t" || c === "\n" || c === "\r" ||
    c === "," || c === ";" || c === "}" || c === "]" || c === ")";
  // Count leading backslashes; an opening quote produces a quoted marker
  // value, which is exempt only when the closing quote follows the "]"
  // immediately (same quote, matching backslash run). Otherwise the
  // quoted string still holds value and must be redacted, not exempt.
  let i = pos;
  const openBsStart = i;
  while (i < s.length && s[i] === "\\") i++;
  const openBs = i - openBsStart;
  let openQuote: string | undefined;
  if (i < s.length && (s[i] === '"' || s[i] === "'" || s[i] === "`")) {
    openQuote = s[i] as string;
    i++;
  }
  const m = /^\[REDACTED:[A-Z_]+\]/.exec(s.slice(i));
  if (m) {
    const closeEnd = i + m[0].length;
    if (openQuote !== undefined) {
      let j = closeEnd;
      const closeBsStart = j;
      while (j < s.length && s[j] === "\\") j++;
      const closeBs = j - closeBsStart;
      if (s[j] !== openQuote || closeBs !== openBs) {
        return { isMarker: false, end: undefined };
      }
      const after = j + 1;
      if (after >= s.length) return { isMarker: true, end: closeEnd };
      const nc = s[after] as string;
      if (nc === "…") return { isMarker: true, end: closeEnd };
      if (isDelim(nc)) return { isMarker: true, end: closeEnd };
      // tail inside the quoted value => not exempt
      return { isMarker: false, end: undefined };
    }
    let after = closeEnd;
    // skip escape/quote characters that close an outer quoted context
    while (after < s.length && (s[after] === "\\" || s[after] === '"' || s[after] === "'" || s[after] === "`")) after++;
    if (after >= s.length) return { isMarker: true, end: closeEnd };
    const nc = s[after] as string;
    if (nc === "…") return { isMarker: true, end: closeEnd };
    if (isDelim(nc)) return { isMarker: true, end: closeEnd };
    // tail immediately after marker without delimiter => not exempt (R1)
    return { isMarker: false, end: undefined };
  }
  return { isMarker: false, end: undefined };
}
function redactKeyAssign(input: string): { out: string; redactions: number } {
  const re2 = /(\\*["']?[A-Za-z0-9_.\-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_.\-]*\\*["']?\s*(?:=>|:=|[:=](?![=>]))\s*)/gi;
  let out = "";
  let cursor = 0;
  let redactions = 0;
  re2.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re2.exec(input)) !== null) {
    const matchStart = m.index;
    const prefix = m[0];
    const valueStart = matchStart + prefix.length;
    out += input.slice(cursor, matchStart);
    if (valueStart >= input.length) {
      out += prefix;
      cursor = valueStart;
      continue;
    }
    // marker exemption (B7)
    const marker = isMarkerAt(input, valueStart);
    if (marker.isMarker) {
      // copy prefix plus marker verbatim up to marker end (include marker text itself)
      // valueStart..marker.end is the marker (with possible quotes)
      // include the marker text (from valueStart to marker.end) plus any immediate closing quotes handled in marker logic
      // To keep text identical, copy from valueStart to marker.end plus trailing quote chars if present
      let copyEnd = marker.end as number;
      // include any closing quote escape sequence already counted? extend to actual marker end including trailing quote
      // search forward to include trailing delimiter-quote characters that belong to marker
      // the marker end we computed is after ']' but before trailing quotes; keep those in output by including up to copyEnd plus any trailing quotes already part of copy range?
      // For simplicity copy exactly the marker substring starting at valueStart up to the character after ']' plus its closing quotes if they were skipped.
      // We will advance copyEnd to include the quote-skipping we did: compute again
      let p = valueStart;
      let i = p;
      while (i < input.length && input[i] === "\\") i++;
      if (i < input.length && (input[i] === '"' || input[i] === "'" || input[i] === "`")) { i++; }
      const close = input.indexOf("]", i);
      let after = close + 1;
      while (after < input.length && (input[after] === "\\" || input[after] === '"' || input[after] === "'" || input[after] === "`")) after++;
      // after now is past marker and its closing quotes, but we want to include closing quotes in the copy
      // Use after as end if after>copyEnd
      if (after > copyEnd) copyEnd = after;
      out += prefix;
      out += input.slice(valueStart, copyEnd);
      cursor = copyEnd;
      // re2 lastIndex already at valueStart; ensure it moves past marker so we don't re-match inside marker
      re2.lastIndex = copyEnd;
      continue;
    }
    // determine value kind
    let n = 0;
    while (valueStart + n < input.length && input[valueStart + n] === "\\") n++;
    const nc = valueStart + n < input.length ? (input[valueStart + n] as string) : "";
    const isQuote = nc === '"' || nc === "'" || nc === "`";
    let valueEnd = valueStart;
    if (isQuote) {
      const openQuote: string = nc;
      const openRun = n;
      // Depth-aware closing: only a quote with exactly the opener's
      // backslash run closes. At depth >= 1 an escaped inner quote has a
      // longer run; at literal depth 1 a single-quote value's inner quote
      // has an even run (originally one backslash, doubled by the escape
      // layer) -- parity would mistake it for the closer.
      const closingPos = findQuotedEnd(input, valueStart + n, openRun);
      if (closingPos !== -1) {
        valueEnd = closingPos + 1;
        // include any trailing backslashes/quotes that are part of escaped closing? already included
        // For depth layers, closing may be followed by extra backslashes that are part of outer escaping? include them?
        // The closing quote we found already accounts for its preceding backslashes; extra backslashes after quote are not part of value.
      } else {
        // unterminated: consume to end (fail-closed)
        valueEnd = input.length;
      }
    } else {
      // bare value: [^\s,;`]+  but also stop before marker? we already handled marker
      let e = valueStart;
      while (e < input.length) {
        const c = input[e] as string;
        if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "," || c === ";" || c === "`" || c === "…") break;
        // stop if we encounter a marker start? not needed
        e++;
      }
      valueEnd = e;
      if (valueEnd === valueStart) {
        // no bare value chars
        out += prefix;
        cursor = valueStart;
        continue;
      }
    }
    out += prefix + "[REDACTED:KEY_ASSIGN]";
    redactions += 1;
    cursor = valueEnd;
    re2.lastIndex = valueEnd;
  }
  out += input.slice(cursor);
  return { out, redactions };
}

/** Bare-token character class shared by the scanner below. */
const BEARER_BARE_CHAR = /[A-Za-z0-9\-._~+/=]/;

/**
 * Depth-aware `Bearer` scanner. The separator after the keyword is
 * whitespace or escaped whitespace (`\t`, `\n`, `\r` at any escape depth),
 * then the token is either bare or quoted (`"`/`'`) whose closing quote
 * must carry exactly the opener's backslash run (same rule as
 * `redactKeyAssign`). The whole `Bearer <sep> <token>` span is replaced by
 * the marker, matching the previous regex behaviour.
 */
function redactBearer(input: string): { out: string; redactions: number } {
  const re = globalOf(BEARER_HEAD);
  let out = "";
  let cursor = 0;
  let redactions = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    const matchStart = m.index;
    let i = matchStart + m[0].length;
    // separator: whitespace and escaped whitespace at any escape depth
    while (i < input.length) {
      const c = input[i] as string;
      if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
      if (c === "\\") {
        let n = 0;
        while (i + n < input.length && input[i + n] === "\\") n++;
        const after = input[i + n] as string | undefined;
        if (after === "t" || after === "n" || after === "r") { i += n + 1; continue; }
      }
      break;
    }
    if (i === matchStart + m[0].length) {
      out += input.slice(cursor, matchStart) + m[0];
      cursor = i;
      continue;
    }
    out += input.slice(cursor, matchStart);
    const valueStart = i;
    let tokenEnd = -1;
    if (valueStart < input.length) {
      let n = 0;
      while (valueStart + n < input.length && input[valueStart + n] === "\\") n++;
      const nc = valueStart + n < input.length ? (input[valueStart + n] as string) : "";
      if (nc === '"' || nc === "'") {
        const openBs = n;
        const closingPos = findQuotedEnd(input, valueStart + n, openBs);
        // unterminated quoted token: consume to end (fail-closed)
        tokenEnd = closingPos !== -1 ? closingPos + 1 : input.length;
      } else if (n === 0) {
        let e = valueStart;
        while (e < input.length && BEARER_BARE_CHAR.test(input[e] as string)) e++;
        if (e > valueStart) tokenEnd = e;
      }
    }
    if (tokenEnd < 0) {
      out += input.slice(matchStart, valueStart);
      cursor = valueStart;
      continue;
    }
    out += "[REDACTED:BEARER]";
    redactions += 1;
    cursor = tokenEnd;
    re.lastIndex = tokenEnd;
  }
  out += input.slice(cursor);
  return { out, redactions };
}

export function redact(text: string): RedactResult {
  let out = text;
  let redactions = 0;
  const classes: RedactClass[] = [];
  const addClass = (cls: RedactClass): void => {
    if (!classes.includes(cls)) classes.push(cls);
  };
  const note = (cls: RedactClass): void => {
    redactions += 1;
    addClass(cls);
  };

  // PRIVATE_KEY: terminated block, then unterminated fallback.
  out = out.replace(globalOf(PEM_TERMINATED), () => {
    note("PRIVATE_KEY");
    return "[REDACTED:PRIVATE_KEY]";
  });
  out = out.replace(globalOf(PEM_UNTERMINATED), () => {
    note("PRIVATE_KEY");
    return "[REDACTED:PRIVATE_KEY]";
  });

  // BEARER: case-insensitive scheme (R2), bare or quoted token; depth-aware
  // scanner (escaped-whitespace separators, escaped-quoted tokens).
  {
    const br = redactBearer(out);
    if (br.redactions > 0) {
      out = br.out;
      redactions += br.redactions;
      addClass("BEARER");
    }
  }

  // JWT
  out = out.replace(globalOf(JWT), () => {
    note("JWT");
    return "[REDACTED:JWT]";
  });

  // KEY_ASSIGN: manual scanner (depth-aware, B6/B8)
  {
    const ka = redactKeyAssign(out);
    if (ka.redactions > 0) {
      out = ka.out;
      redactions += ka.redactions;
      addClass("KEY_ASSIGN");
    }
  }

  // URL_CREDS
  out = out.replace(globalOf(URL_CREDS), () => {
    note("URL_CREDS");
    return "[REDACTED:URL_CREDS]";
  });

  // APPCHECK_DEBUG: UUID after the phrase, or value assigned to the env var.
  out = out.replace(globalOf(APPCHECK_A), () => {
    note("APPCHECK_DEBUG");
    return "AppCheck debug token: [REDACTED:APPCHECK_DEBUG]";
  });
  out = out.replace(globalOf(APPCHECK_B), (_m: string, prefix: string) => {
    note("APPCHECK_DEBUG");
    return prefix + "[REDACTED:APPCHECK_DEBUG]";
  });

  // EMAIL
  out = out.replace(globalOf(EMAIL), () => {
    note("EMAIL");
    return "[REDACTED:EMAIL]";
  });

  // HOME_PATH: username in /home/<u>, /Users/<u>, C:\Users\<u>, C:/Users/<u>.
  out = out.replace(globalOf(HOME_UNIX), (_m: string, prefix: string) => {
    note("HOME_PATH");
    return prefix + "[REDACTED:HOME_PATH]";
  });
  out = out.replace(globalOf(HOME_WIN), (_m: string, prefix: string) => {
    note("HOME_PATH");
    return prefix + "[REDACTED:HOME_PATH]";
  });

  // HIGH_ENTROPY
  out = out.replace(globalOf(ENTROPY), (run: string) => {
    if (!isHighEntropyRun(run)) return run;
    note("HIGH_ENTROPY");
    return "[REDACTED:HIGH_ENTROPY]";
  });

  return { text: out, redactions, classes };
}

/** True when any redaction class (including home-path PII) still matches. */
export function hasRedactResidue(text: string): boolean {
  // B9: a trailing U+2026 is U08's own truncation marker, not content; strip
  // it so a bare `…` counts as neither value nor residue.
  const t = text.endsWith("…") ? text.slice(0, -1) : text;
  if (PEM_TERMINATED.test(t)) return true;
  if (PEM_UNTERMINATED.test(t)) return true;
  if (redactBearer(t).redactions > 0) return true;
  if (JWT.test(t)) return true;
  if (redactKeyAssign(t).redactions > 0) return true;
  // legacy regex as fallback for simple cases where scanner missed (bare already covered)
  if (KEY_ASSIGN.test(t)) {
    // scanner is authoritative; if regex hits but scanner does not, treat as residue (fail-closed)
    // to catch cases scanner may have missed due to bare values with `=>` etc.
    // However scanner already covers bare; keep regex as safety net only when scanner would also have redacted.
    // The scanner above already returns true if it can redact, so this is redundant but safe.
    // Return true to be fail-closed.
    if (redactKeyAssign(t).redactions > 0) return true;
    // If scanner missed but regex hits, still residue (should not happen after depth fix, but fail-closed)
    return true;
  }
  if (URL_CREDS.test(t)) return true;
  if (APPCHECK_A.test(t)) return true;
  if (APPCHECK_B.test(t)) return true;
  if (EMAIL.test(t)) return true;
  if (HOME_UNIX.test(t)) return true;
  if (HOME_WIN.test(t)) return true;
  if (hasHighEntropyRun(t)) return true;
  return false;
}
