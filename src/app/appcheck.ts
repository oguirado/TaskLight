/** B4: true only for http://localhost:<port> and http://127.0.0.1:<port> (exact hostname, numeric port). */
export function isLocalDevOrigin(origin: string): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== "http:") return false;
  if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1") return false;
  if (u.port === "") return false;
  return true;
}
