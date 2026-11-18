import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RUN_PARAMETERS } from "@seshat/orchestrator";
import { flatFields, labelOf, subJson, subValues } from "../web/src/fields.ts";

describe("the settings panel's fields (UX9)", () => {
  it("names a key in words, the key itself kept beside it", () => {
    assert.equal(labelOf("budgetShare"), "Budget share");
    assert.equal(labelOf("capUsd"), "Cap USD");
    assert.equal(labelOf("llmJudge"), "LLM judge");
    assert.equal(labelOf("timeoutSec"), "Timeout (seconds)");
    assert.equal(labelOf("triage"), "Triage");
  });

  it("gives a flat object type typed fields, and leaves a nested or untyped one to its JSON box", () => {
    assert.deepEqual(flatFields("{ maxSorries?: integer >= 1, timeoutSec?: number >= 1 }"), [
      { name: "maxSorries", optional: true, kind: "integer", type: "integer >= 1" },
      { name: "timeoutSec", optional: true, kind: "number", type: "number >= 1" },
    ]);
    assert.deepEqual(flatFields("{ schedule?: geometric | luby, base?: integer }")?.[0], { name: "schedule", optional: true, kind: "choice", choices: ["geometric", "luby"], type: "geometric | luby" });
    assert.equal(flatFields("{ problemUsd: number > 0 }")?.[0]?.optional, false);
    assert.equal(flatFields("{ show?: boolean, weights?: Record<kind, number> }"), undefined, "a Record stays JSON");
    assert.equal(flatFields("{ limit: { tokens?, usd? }, narrative: boolean }"), undefined, "a nested object stays JSON");
    assert.equal(flatFields("{ share?, floor? }"), undefined, "a field without its type stays JSON");
    assert.equal(flatFields("string[]"), undefined);
  });

  it("parses every JSON setting of the catalogue without throwing, and gives the flat ones fields", () => {
    const json = Object.entries(RUN_PARAMETERS as Record<string, { type: string }>).filter(([, p]) => p.type.trim().startsWith("{"));
    assert.ok(json.length > 0);
    for (const [key, p] of json) {
      const fields = flatFields(p.type);
      if (fields !== undefined) for (const f of fields) assert.match(f.name, /^\w+$/, `${key}: ${f.name}`);
    }
    assert.ok(flatFields(RUN_PARAMETERS.sorryBattery.type) !== undefined, "sorryBattery gets fields");
  });

  it("writes only the filled sub-fields, typed, and reads them back", () => {
    const fields = flatFields("{ maxSorries?: integer >= 1, reflect?: boolean, schedule?: geometric | luby, model?: provider/id }") ?? [];
    assert.equal(subJson(fields, {}), "", "nothing filled: nothing sent");
    const text = subJson(fields, { maxSorries: "4", reflect: "false", schedule: "luby", model: " " });
    assert.deepEqual(JSON.parse(text), { maxSorries: 4, reflect: false, schedule: "luby" });
    assert.deepEqual(subValues(text), { maxSorries: "4", reflect: "false", schedule: "luby" });
    assert.deepEqual(subValues(""), {});
    assert.equal(subValues("[1]"), undefined, "not an object: the JSON box stays the editor");
    assert.equal(subValues("{bad"), undefined);
  });
});
