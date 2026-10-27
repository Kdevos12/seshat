import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveLines, resumeRefusals } from "@seshat/lines";
import { LINES } from "../src/index.ts";

/** The reasons a run with these lines cannot be resumed. */
function refusals(...ids: string[]): string[] {
  const { lines, problems } = resolveLines(ids, LINES);
  assert.deepEqual(problems, []);
  return resumeRefusals(lines);
}

describe("the lines a run can be resumed with", () => {
  it("accepts M0 and M1, which keep nothing in the process", () => {
    assert.deepEqual(refusals(), []);
    assert.deepEqual(refusals("M1"), []);
  });

  it("refuses M2, M6 and the fleet, which do, and says what they keep", () => {
    const [m2] = refusals("M1", "M2");
    assert.match(m2 ?? "", /^line M2 cannot be resumed: .*truth-maintenance state/);
    const [m6] = refusals("M1", "M6");
    assert.match(m6 ?? "", /^line M6 cannot be resumed: .*detectors' counts/);
    const [fleet] = refusals("M1", "fleet");
    assert.match(fleet ?? "", /^line fleet cannot be resumed: .*width gate/);
    assert.equal(refusals("M1", "M2", "M6", "fleet").length, 3, "each line that cannot is named");
  });

  it("gives every line the repository registers a position on resuming", () => {
    for (const line of Object.values(LINES)) {
      assert.ok(line.resume === "stateless" || (typeof line.resume === "object" && line.resume.refuse.length > 0), `line ${line.id} says how it resumes`);
    }
  });
});
