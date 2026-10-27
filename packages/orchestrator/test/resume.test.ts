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

  it("accepts M2, M6 and the fleet, which rebuild what they keep from the journal", () => {
    assert.deepEqual(refusals("M1", "M2"), []);
    assert.deepEqual(refusals("M1", "M6"), []);
    assert.deepEqual(refusals("M1", "fleet"), []);
    assert.deepEqual(refusals("M1", "M2", "M6", "fleet"), []);
    for (const id of ["M2", "M6", "fleet"] as const) {
      assert.equal(LINES[id]?.resume, "rebuild", id);
      assert.equal(typeof LINES[id]?.hooks.resumeProblem, "function", `${id} gives the hook that rebuilds`);
    }
  });

  it("refuses a line that says it rebuilds and gives no hook, one that says nothing, and one that refuses, each by name", () => {
    const hooks = {};
    const lines = [
      { line: { id: "M2", title: "t", requires: [], resume: "rebuild", hooks }, options: {} },
      { line: { id: "M6", title: "t", requires: [], hooks }, options: {} },
      { line: { id: "fleet", title: "t", requires: [], resume: { refuse: "it keeps a socket" }, hooks }, options: {} },
    ] as unknown as Parameters<typeof resumeRefusals>[0];
    assert.deepEqual(resumeRefusals(lines), [
      "line M2 cannot be resumed: it says it rebuilds its state and gives no `resumeProblem` hook to do it",
      'line M6 cannot be resumed: it does not say how it resumes (set `resume` on the line to "stateless", "rebuild" or {refuse: reason})',
      "line fleet cannot be resumed: it keeps a socket",
    ]);
  });

  it("gives every line the repository registers a position on resuming", () => {
    for (const line of Object.values(LINES)) {
      assert.ok(line.resume === "stateless" || line.resume === "rebuild" || (typeof line.resume === "object" && line.resume.refuse.length > 0), `line ${line.id} says how it resumes`);
    }
  });
});
