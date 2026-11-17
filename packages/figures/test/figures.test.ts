import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FIGURES, IMAGES_DIR, render } from "../src/index.ts";
import { lineWidth, spans } from "../src/svg.ts";

describe("the figures of the documentation", () => {
  for (const [name, build] of Object.entries(FIGURES)) {
    it(`${name}: every text fits, and documentation/images/${name}.svg is its output`, () => {
      const { svg, problems } = render(build);
      assert.deepEqual(problems, [], "a text overflows its box");
      const path = join(IMAGES_DIR, `${name}.svg`);
      assert.ok(existsSync(path), `${path} is missing: run pnpm figures`);
      assert.equal(readFileSync(path, "utf8"), svg, `${path} differs from its figure: run pnpm figures`);
    });
  }

  it("has no model name or id in any figure", () => {
    for (const [name, build] of Object.entries(FIGURES)) {
      const { svg } = render(build);
      assert.doesNotMatch(svg, /\b(gpt-|claude|gemini|deepseek|llama|qwen|mistral)/i, name);
    }
  });
});

describe("the SVG toolkit", () => {
  it("splits inline markup into spans", () => {
    assert.deepEqual(spans("a **b** `c` _d_"), [
      { text: "a " },
      { text: "b", bold: true },
      { text: " " },
      { text: "c", mono: true },
      { text: " " },
      { text: "d", italic: true },
    ]);
  });

  it("measures text with Helvetica's metrics", () => {
    assert.ok(Math.abs(lineWidth("i", 10) - 2.22) < 1e-9);
    assert.ok(lineWidth("W", 10) > lineWidth("i", 10));
    assert.equal(lineWidth("`abc`", 10), 3 * 0.6 * 10);
  });
});
