import type { CapsuleEvent } from "./types";
import { canonicalJson } from "./canonical";

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function toUtf8Bytes(s: string): Uint8Array {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(s);
  }
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let cp: number;
    if (c >= 0xd800 && c <= 0xdbff) {
      const c2 = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        cp = 0x10000 + (c - 0xd800) * 0x400 + (c2 - 0xdc00);
        i++;
      } else {
        cp = 0xfffd;
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      cp = 0xfffd;
    } else {
      cp = c;
    }
    if (cp < 0x80) {
      bytes.push(cp);
    } else if (cp < 0x800) {
      bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}

function rightRotate(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

export function digestHex(s: string): string {
  const bytes = toUtf8Bytes(s);
  const bitLenHi = Math.floor(bytes.length / 0x20000000);
  const bitLenLo = (bytes.length * 8) >>> 0;
  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6;
  const msg = new Uint8Array(paddedLength);
  msg.set(bytes);
  msg[bytes.length] = 0x80;
  const view = new DataView(msg.buffer);
  view.setUint32(paddedLength - 8, bitLenHi >>> 0, false);
  view.setUint32(paddedLength - 4, bitLenLo >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let block = 0; block < paddedLength; block += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(block + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15] as number;
      const y = w[i - 2] as number;
      const s0 = (rightRotate(x, 7) ^ rightRotate(x, 18) ^ (x >>> 3)) >>> 0;
      const s1 = (rightRotate(y, 17) ^ rightRotate(y, 19) ^ (y >>> 10)) >>> 0;
      w[i] = (w[i - 16] as number) + s0 + (w[i - 7] as number) + s1;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i++) {
      const s1 = (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + s1 + ch + (K[i] as number) + (w[i] as number)) >>> 0;
      const s0 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const words = [h0, h1, h2, h3, h4, h5, h6, h7];
  let out = "";
  for (const word of words) {
    out += (word >>> 0).toString(16).padStart(8, "0");
  }
  return out;
}

export function replayDigest(events: readonly CapsuleEvent[]): string {
  const sorted = [...events].sort((x, y) => {
    if (x.ts !== y.ts) return x.ts - y.ts;
    if (x.projectId !== y.projectId) return x.projectId < y.projectId ? -1 : 1;
    if (x.source !== y.source) return x.source < y.source ? -1 : 1;
    if (x.sourceSeq !== y.sourceSeq) return x.sourceSeq - y.sourceSeq;
    return x.eventId < y.eventId ? -1 : x.eventId > y.eventId ? 1 : 0;
  });
  return digestHex(sorted.map((e) => canonicalJson(e)).join("\n"));
}
