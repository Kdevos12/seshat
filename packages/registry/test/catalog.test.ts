import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { describe, it } from "node:test";
import {
  CatalogError,
  checkHostProfile,
  describeCapability,
  loadCatalog,
  loadHostProfile,
  parseHostProfile,
} from "../src/index.ts";
import { addManifest, writeCatalog } from "./helpers.ts";

const REPO = new URL("../../../", import.meta.url).pathname;

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof CatalogError) return error.problems;
    throw error;
  }
  return [];
}

describe("loadCatalog", () => {
  it("loads manifests and contracts, with $file references", () => {
    const dir = writeCatalog({
      "math.add": {
        manifest: addManifest({ description: { $file: "description.md" } }),
        contract: { capability: "math.add", cases: [{ name: "small", input: { a: 1, b: 2 }, expect: [{ path: "sum", equals: 3 }] }] },
        files: { "description.md": "Adds a and b.\n" },
      },
    });
    const catalog = loadCatalog(dir);
    const add = catalog.capabilities.get("math.add");
    assert.ok(add);
    assert.equal(add.manifest.description, "Adds a and b.\n");
    assert.equal(add.contract.length, 1);
    assert.match(catalog.hash, /^[0-9a-f]{64}$/);
    assert.notEqual(loadCatalog(writeCatalog({ "math.add": { manifest: addManifest({ timeoutMs: 1 }) } })).hash, catalog.hash);
  });

  it("reports every problem of the catalog at once", () => {
    const dir = writeCatalog({
      "math.sum": { manifest: addManifest() },
      "math.mul": {
        manifest: addManifest({
          id: "math.mul",
          input: { type: "object", properties: { a: { type: "number", format: "double" } } },
          produces: ["proved"],
          summary: ["a..b"],
          implementations: [
            { id: "js", version: "1", kind: "inproc", factory: "f", tool: "x" },
            { id: "js", version: "2", kind: "mcp", tool: "mul", server: { transport: "http", command: "node" } },
          ],
        }),
        contract: { capability: "math.add", cases: [] },
      },
      "math.div": {
        manifest: addManifest({ id: "math.div", examples: [{ title: "bad", input: { a: "1", b: 2 } }] }),
        contract: {
          capability: "math.div",
          cases: [{ name: "c", input: { a: 1 }, expect: [{ path: "sum", equals: 1, atMost: 2 }, { path: "sum", matches: "(" }] }],
        },
      },
      "math.escape": { manifest: addManifest({ id: "math.escape", description: { $file: "../secret" } }) },
    });
    const problems = problemsOf(() => loadCatalog(dir)).map((p) => p.replace(dir, "<catalog>"));
    assert.deepEqual(problems, [
      'math.div: example "bad": input.a: expected number, got string',
      'math.div: contract case "c": input: missing property "b"',
      'math.div: contract case "c": expectation at "sum" needs exactly one of equals, matches, length, atLeast, atMost, exists, some, every',
      'math.div: contract case "c": matches: Invalid regular expression: /(/u: Unterminated group',
      '<catalog>/math.escape/manifest.json: $file "../secret" is outside the capability\'s directory',
      'math.mul: input.properties.a: unsupported keyword "format"',
      "math.mul: implementation js (inproc) cannot have tool",
      "math.mul: implementation js is declared twice",
      "math.mul: implementation js: server: an http server needs a url",
      "math.mul: implementation js: server: an http server cannot have command",
      "math.mul: produces proved, so it must say what certifies it (certificate)",
      'math.mul: summary: bad path segment "" in "a..b"',
      'math.mul: contract.json is for "math.add"',
      'math.add: the directory must be named after the id, not "math.sum"',
    ]);
  });

  it("writes a manifest out for a model", () => {
    const catalog = loadCatalog(writeCatalog({ "math.add": { manifest: addManifest() } }));
    const text = describeCapability(catalog.capabilities.get("math.add")?.manifest as never);
    assert.equal(
      text,
      [
        "math.add: Add two numbers",
        "",
        "Adds a and b and returns their sum.",
        "",
        "Use it for:",
        "- adding two numbers",
        "",
        "Do not use it for:",
        "- multiplying",
        "",
        "Input:",
        "  a: number. The first term",
        "  b: number",
        "",
        "Output:",
        "  sum: number",
        "",
        "Example: two and two",
        '  input: {"a":2,"b":2}',
        '  output: {"sum":4}',
      ].join("\n"),
    );
  });
});

describe("host profiles", () => {
  const catalog = loadCatalog(writeCatalog({ "math.add": { manifest: addManifest() } }));

  it("must name known capabilities, implementations and settings", () => {
    const profile = parseHostProfile({
      host: "local",
      capabilities: {
        "math.add": { use: ["js", "nope", "js"], settings: { other: { url: "x" } } },
        "math.mul": { use: ["js"] },
      },
    });
    assert.deepEqual(checkHostProfile(profile, catalog), [
      "host local: math.add has no implementation nope",
      "host local: math.add lists an implementation twice",
      "host local: settings for unknown implementation math.add/other",
      "host local: unknown capability math.mul",
    ]);
  });

  it("refuses a malformed profile", () => {
    assert.deepEqual(problemsOf(() => parseHostProfile({ host: "Local", capabilities: { x: { use: [] } } })), [
      "host profile $.host: does not match /^[a-z][a-z0-9-]*$/",
      "host profile $.capabilities.x.use: fewer than 1 items",
    ]);
  });
});

describe("the repository's catalog", () => {
  it("loads, and every host profile matches it", () => {
    const catalog = loadCatalog(`${REPO}capabilities`);
    assert.ok(catalog.capabilities.has("lean.check"));
    const hosts = readdirSync(`${REPO}config/hosts`).filter((f) => f.endsWith(".json"));
    assert.ok(hosts.length >= 2);
    for (const file of hosts) {
      const profile = loadHostProfile(`${REPO}config/hosts/${file}`);
      assert.equal(`${profile.host}.json`, file);
      assert.deepEqual(checkHostProfile(profile, catalog), []);
    }
  });
});
