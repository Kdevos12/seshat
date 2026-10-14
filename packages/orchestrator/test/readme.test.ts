import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadCatalog } from "@seshat/registry";
import { REPO_ROOT, toolName } from "../src/index.ts";

/** The diagram of the research flow: the first `mermaid` block of README.md. */
function diagram(): string {
  const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
  const block = /```mermaid\n([\s\S]*?)```/.exec(readme);
  assert.ok(block, "README.md has no mermaid block");
  return block[1]!;
}

const MARKS = ["built", "wait", "planned"];

describe("the README's diagram of the research flow", () => {
  it("names the tool of every capability", () => {
    const text = diagram();
    const tools = [...loadCatalog(join(REPO_ROOT, "capabilities")).capabilities.keys()].map(toolName);
    assert.deepEqual(
      tools.filter((name) => !text.includes(name)),
      [],
      "README.md's diagram must show every capability (documentation/development.md#conventions)",
    );
  });

  it("marks every node built, waiting for Lean, or planned", () => {
    const text = diagram();
    for (const mark of MARKS) assert.match(text, new RegExp(`^\\s*classDef ${mark} `, "m"));
    const nodes = [...text.matchAll(/^\s*(\w+)\[".*"\](?::::(\w+))?\s*$/gm)];
    assert.ok(nodes.length > 0);
    assert.deepEqual(
      nodes.filter(([, , mark]) => mark === undefined || !MARKS.includes(mark)).map(([, id]) => id),
      [],
      "each node of README.md's diagram ends with :::built, :::wait or :::planned",
    );
  });
});
