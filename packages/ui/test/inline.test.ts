import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pieces } from "../web/src/inline.ts";

describe("the doctor's words drawn as styles (UX11)", () => {
  it("cuts bold, code and links, and marks the commands a person types", () => {
    assert.deepEqual(pieces("Run `pnpm harness lean-env build` (it downloads Mathlib)."), [
      { kind: "text", text: "Run ", bold: false },
      { kind: "code", text: "pnpm harness lean-env build", bold: false, command: true },
      { kind: "text", text: " (it downloads Mathlib).", bold: false },
    ]);
    assert.deepEqual(pieces("**stays `computed`.** Then"), [
      { kind: "text", text: "stays ", bold: true },
      { kind: "code", text: "computed", bold: true },
      { kind: "text", text: ".", bold: true },
      { kind: "text", text: " Then", bold: false },
    ]);
    assert.deepEqual(pieces("Install Lean with elan (https://github.com/leanprover/elan), then go."), [
      { kind: "text", text: "Install Lean with elan (", bold: false },
      { kind: "link", text: "https://github.com/leanprover/elan", bold: false },
      { kind: "text", text: "), then go.", bold: false },
    ]);
  });

  it("leaves an unpaired mark as the character it is", () => {
    assert.deepEqual(pieces("a ** b"), [{ kind: "text", text: "a ** b", bold: false }]);
    assert.deepEqual(pieces("x `y"), [{ kind: "text", text: "x `y", bold: false }]);
    assert.deepEqual(pieces(""), []);
    assert.deepEqual(pieces("no `lake` here"), [
      { kind: "text", text: "no ", bold: false },
      { kind: "code", text: "lake", bold: false },
      { kind: "text", text: " here", bold: false },
    ], "a program named alone is not a command to copy");
  });
});
