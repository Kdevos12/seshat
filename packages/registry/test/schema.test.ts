import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkPath, checkSchema, getPath, interpolate, MissingVariableError, renderSchema, validate, type JsonSchema } from "../src/index.ts";

const SNIPPETS: JsonSchema = {
  type: "object",
  required: ["snippets"],
  properties: {
    snippets: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["id", "code"],
        properties: { id: { type: "string", pattern: "^[a-z]+$" }, code: { type: "string", minLength: 1 } },
        additionalProperties: false,
      },
    },
    timeoutSec: { type: "integer", minimum: 1, maximum: 3600 },
    mode: { enum: ["fast", "full"] },
  },
  additionalProperties: false,
};

describe("validate", () => {
  it("accepts a valid value", () => {
    assert.deepEqual(validate(SNIPPETS, { snippets: [{ id: "a", code: "example : True := trivial" }], timeoutSec: 60 }), []);
  });

  it("reports every violation with its path", () => {
    const errors = validate(SNIPPETS, { snippets: [{ id: "A1", code: "", extra: 1 }, { code: 3 }], timeoutSec: 1.5, mode: "slow", x: 1 });
    assert.deepEqual(errors, [
      "$.snippets[0].id: does not match /^[a-z]+$/",
      "$.snippets[0].code: shorter than 1 characters",
      '$.snippets[0]: unexpected property "extra"',
      '$.snippets[1]: missing property "id"',
      "$.snippets[1].code: expected string, got integer",
      "$.timeoutSec: expected integer, got number",
      '$.mode: must be one of "fast", "full"',
      '$: unexpected property "x"',
    ]);
  });

  it("checks types, bounds, constants and alternatives", () => {
    assert.deepEqual(validate({ type: "array", maxItems: 1 }, [1, 2]), ["$: more than 1 items"]);
    assert.deepEqual(validate({ type: ["string", "null"] }, null), []);
    assert.deepEqual(validate({ const: "proved" }, "open"), ['$: must be "proved"']);
    assert.deepEqual(validate({ type: "string", maxLength: 2 }, "∀∃"), []);
    assert.deepEqual(validate({ type: "number", minimum: 0 }, -1), ["$: less than 0"]);
    assert.deepEqual(validate({ type: "number" }, Number.NaN), ["$: expected number, got number"]);
    assert.deepEqual(validate({ type: "object", additionalProperties: { type: "string" } }, { a: "x", b: 2 }), [
      "$.b: expected string, got integer",
    ]);
    const shape: JsonSchema = { anyOf: [{ type: "string" }, { type: "object", required: ["file"] }] };
    assert.deepEqual(validate(shape, "x"), []);
    assert.deepEqual(validate(shape, { file: "a" }), []);
    assert.match(validate(shape, {})[0] as string, /matches none of the allowed shapes \(closest: \$: missing property "file"\)/);
    assert.deepEqual(validate({}, { anything: [1, "two"] }), []);
  });
});

describe("checkSchema", () => {
  it("accepts the supported subset", () => {
    assert.deepEqual(checkSchema(SNIPPETS), []);
  });

  it("refuses keywords it would not check", () => {
    assert.deepEqual(checkSchema({ type: "object", properties: { at: { type: "string", format: "date-time" } } }), [
      '$.properties.at: unsupported keyword "format"',
    ]);
    assert.deepEqual(checkSchema({ type: "text" }), ["$.type: must be one of object, array, string, number, integer, boolean, null, or a list of them"]);
    assert.match(checkSchema({ pattern: "(" })[0] as string, /^\$\.pattern: /);
    assert.deepEqual(checkSchema({ minItems: -1, required: [1] }), ["$.minItems: must be a natural number", "$.required: must be a list of property names"]);
  });
});

describe("renderSchema", () => {
  it("writes schemas in a compact notation", () => {
    assert.equal(
      renderSchema(SNIPPETS),
      '{snippets: {id: string, code: string}[], timeoutSec?: integer, mode?: "fast" | "full"}',
    );
    assert.equal(renderSchema({ type: "array", items: { enum: ["a", "b"] } }), '("a" | "b")[]');
    assert.equal(renderSchema({ type: "object", additionalProperties: { type: "integer" } }), "{[key: string]: integer}");
    assert.equal(renderSchema({}), "any");
  });
});

describe("paths", () => {
  const output = { results: [{ id: "a", status: "valid" }, { id: "b", status: "sorry", sorries: [{ goal: "⊢ True" }] }] };

  it("reads values by index and maps over lists with *", () => {
    assert.equal(getPath(output, "results.1.status"), "sorry");
    assert.deepEqual(getPath(output, "results.*.status"), ["valid", "sorry"]);
    // The first result has no `sorries`, so it gives nothing.
    assert.deepEqual(getPath(output, "results.*.sorries.*.goal"), [["⊢ True"]]);
    assert.equal(getPath(output, "results.2.status"), undefined);
    assert.equal(getPath(output, "results.x"), undefined);
    assert.deepEqual(getPath(output, ""), output);
  });

  it("checks path syntax", () => {
    assert.deepEqual(checkPath("results.*.status"), []);
    assert.deepEqual(checkPath("results..status"), ['bad path segment "" in "results..status"']);
  });
});

describe("interpolate", () => {
  const variables = { dir: "/repo/capabilities/x", env: { KEY: "s3cret", EMPTY: "" } };

  it("substitutes the directory and environment variables", () => {
    assert.deepEqual(
      interpolate({ command: "${dir}/run.sh", args: ["--key", "${env:KEY}"], n: 3, url: "${env:URL:-http://localhost:8000}" }, variables),
      { command: "/repo/capabilities/x/run.sh", args: ["--key", "s3cret"], n: 3, url: "http://localhost:8000" },
    );
    assert.equal(interpolate("${env:EMPTY:-default}", variables), "");
    assert.equal(interpolate("$${dir}", variables), "${dir}");
  });

  it("names every missing variable", () => {
    assert.throws(
      () => interpolate({ a: "${env:A}", b: ["${env:B}", "${env:A}"] }, variables),
      (error: unknown) => error instanceof MissingVariableError && error.names.join() === "A,B",
    );
    assert.throws(() => interpolate("${home}", variables), /unknown variable \$\{home\}/);
  });
});
