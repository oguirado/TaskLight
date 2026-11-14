function isHigh(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}
function isLow(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}

// Keep the tail of s (at most max code units), never splitting a surrogate pair.
export function clipTail(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  let start = s.length - max;
  if (start > 0 && isLow(s.charCodeAt(start)) && isHigh(s.charCodeAt(start - 1))) start++;
  return s.slice(start);
}

// Keep the head of s (at most max code units), never splitting a surrogate pair.
export function clipHead(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  let end = max;
  if (end > 0 && end < s.length && isHigh(s.charCodeAt(end - 1)) && isLow(s.charCodeAt(end))) end--;
  return s.slice(0, end);
}
