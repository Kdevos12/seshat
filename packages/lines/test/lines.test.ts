import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ablationLines, isAblationName, isLineId, type Line, LINE_ORDER, type LineRegistry, resolveLines } from "../src/index.ts";

function line(id: Line["id"], extra: Partial<Line> = {}): Line {
  return { id, title: `the line ${id}`, requires: [], hooks: {}, ...extra };
}

describe("line ids and cumulative configs", () => {
  it("orders the lines as the plan builds them, and knows them", () => {
    assert.deepEqual([...LINE_ORDER], ["M1", "M10", "M2", "M11", "M12", "M4", "M6", "fleet", "M3", "M7", "M8", "M13", "M14", "M5", "M9"]);
    assert.ok(isLineId("fleet") && isLineId("M14"));
    assert.ok(!isLineId("M0") && !isLineId("M15") && !isLineId("m1"));
    assert.ok(isAblationName("M0") && isAblationName("M9") && !isAblationName("M15"));
  });

  it("enables every line up to the named one, in the plan's order", () => {
    assert.deepEqual(ablationLines("M0"), []);
    assert.deepEqual(ablationLines("M1"), ["M1"]);
    assert.deepEqual(ablationLines("M2"), ["M1", "M10", "M2"]);
    assert.deepEqual(ablationLines("fleet"), ["M1", "M10", "M2", "M11", "M12", "M4", "M6", "fleet"]);
    assert.deepEqual(ablationLines("M9"), [...LINE_ORDER]);
  });
});

describe("resolveLines", () => {
  const registry: LineRegistry = {
    M1: line("M1", { options: { k: 3, label: "x" } }),
    M2: line("M2", { requires: ["M1"] }),
    M4: line("M4", { hooks: { contextPacket: async () => undefined } }),
    M6: line("M6", { hooks: { contextPacket: async () => undefined } }),
  };

  it("puts the enabled lines in the plan's order, with their options over the defaults", () => {
    const { lines, problems } = resolveLines(["M2", "M1"], registry, { M1: { k: 5 } });
    assert.deepEqual(problems, []);
    assert.deepEqual(lines.map((l) => [l.line.id, l.options]), [["M1", { k: 5, label: "x" }], ["M2", {}]]);
    assert.deepEqual(resolveLines([], registry), { lines: [], problems: [] });
  });

  it("takes any JSON value for an option whose default is null, and keeps the type of the others", () => {
    const optional: LineRegistry = { M1: line("M1", { options: { limit: null, label: "x", depth: 2 } }) };
    for (const value of [5, 0.5, "five", true, false, [1, 2], { max: 3 }, null]) {
      const { lines, problems } = resolveLines(["M1"], optional, { M1: { limit: value } });
      assert.deepEqual(problems, [], JSON.stringify(value));
      assert.deepEqual(lines[0]?.options, { limit: value, label: "x", depth: 2 });
    }
    assert.deepEqual(resolveLines(["M1"], optional).lines[0]?.options, { limit: null, label: "x", depth: 2 }, "unset, it stays null");
    assert.deepEqual(resolveLines(["M1"], optional, { M1: { limit: 5, label: 3, depth: null } }).problems, [
      "option M1.label must be a string, got 3",
      "option M1.depth must be a number, got null",
    ]);
  });

  it("names every problem: unknown, repeated, planned, unmet and conflicting lines, and bad options", () => {
    assert.deepEqual(resolveLines(["M99", "M1", "M1"], registry).problems, [
      `unknown line "M99"; the lines are ${LINE_ORDER.join(", ")}`,
      "line M1 is listed twice",
    ]);
    assert.deepEqual(resolveLines(["M3"], registry).problems, ["line M3 (growing lemma library) is planned, not implemented yet"]);
    assert.deepEqual(resolveLines(["M2"], registry).problems, ["line M2 requires line M1, which is not enabled"]);
    assert.deepEqual(resolveLines(["M4", "M6"], registry).problems, ["lines M4 and M6 all give the context packet; enable one of them"]);
    assert.deepEqual(resolveLines(["M10"], { M10: line("M1") }).problems, ["the line registered as M10 says it is M1"]);
    assert.deepEqual(resolveLines(["M1"], registry, { M1: { k: "five", depth: 2 }, M2: { x: 1 } }).problems, [
      "options given for line M2, which is not enabled",
      'option M1.k must be a number, got "five"',
      "line M1 has no option depth; its options are k, label",
    ]);
  });
});
