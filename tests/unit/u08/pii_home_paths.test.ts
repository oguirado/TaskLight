import { describe, expect, it } from "vitest";
import { normalise, redact } from "../../../src/ingest/index";
import { HOME_PATH_CASES, mkReg, rawEnv } from "./helpers";

// PII policy for usernames in home paths is AUSENTE in SPEC_U08 section 6; these cases encode the
// operator-requested stricter oracle. If the operator rules otherwise, drop this file (see ORACLE.md).
describe("home-path usernames never survive (proposed policy, open question)", () => {
  for (const c of HOME_PATH_CASES) {
    it(c.text, () => {
      const v = normalise(rawEnv({ text: c.text }), mkReg());
      expect(v.ok).toBe(true);
      if (!v.ok) return;
      for (const s of c.secrets) expect(v.value.text).not.toContain(s);
      expect(v.value.text).toContain("error at");
      const r = redact(c.text);
      for (const s of c.secrets) expect(r.text).not.toContain(s);
      expect(redact(r.text).redactions).toBe(0);
    });
  }
});
