// U160: the hosted Wall must declare a responsive viewport so narrow screens (390 px) get the
// narrow layout instead of a 980 px desktop layout scaled down (R42 tier-2 capsule evidence).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(join(process.cwd(), "hosting/index.html"), "utf8");

describe("U160 hosted viewport", () => {
  it("declares width=device-width with initial-scale=1 exactly once", () => {
    const tags = html.match(/<meta\s+name="viewport"[^>]*>/g) ?? [];
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatch(/content="width=device-width,\s*initial-scale=1"/);
  });
  it("never disables user zoom (accessibility)", () => {
    expect(html).not.toMatch(/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(?![.\d])/);
  });
});
