import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseToml, TomlError } from "../src/index.ts";

describe("parseToml", () => {
  it("reads keys, tables, arrays of tables, comments and every value an environment file uses", () => {
    const table = parseToml(`
# a comment
name = "base"   # trailing comment
count = 3
negative = -12
big = 1_000
on = true
off = false
literal = 'C:\\path\\no escapes'
escaped = "tab\\there \\"quoted\\" \\u00e9"
libs = ["A", "B",]
multi = [
  "x",   # first
  "y",
]
inline = { a = 1, b = "two", c = ["z"] }
dotted.key = 1
"quoted key" = 2

[base]
git = "https://example.com/x"

[base.nested]
deep = true

[[package]]
name = "one"

[[package]]
name = "two"
`);
    assert.deepEqual(table, {
      name: "base",
      count: 3,
      negative: -12,
      big: 1000,
      on: true,
      off: false,
      literal: "C:\\path\\no escapes",
      escaped: 'tab\there "quoted" é',
      libs: ["A", "B"],
      multi: ["x", "y"],
      inline: { a: 1, b: "two", c: ["z"] },
      dotted: { key: 1 },
      "quoted key": 2,
      base: { git: "https://example.com/x", nested: { deep: true } },
      package: [{ name: "one" }, { name: "two" }],
    });
  });

  it("refuses what it does not read, with the line, instead of misreading it", () => {
    const line = (text: string): number => {
      try {
        parseToml(text);
      } catch (error) {
        assert.ok(error instanceof TomlError);
        return error.line;
      }
      return assert.fail(`no error for ${JSON.stringify(text)}`);
    };
    assert.equal(line('a = 1\nb = 1.5'), 2);
    assert.equal(line('a = """x"""'), 1);
    assert.equal(line('a = "open'), 1);
    assert.equal(line('a = 1\na = 2'), 2);
    assert.equal(line("[t]\n[t]"), 2);
    assert.equal(line("[[t]]\n[t]"), 2);
    assert.equal(line("a = [1, 2"), 1);
    assert.equal(line("a = 1 b = 2"), 1);
    assert.equal(line("a = 2026-10-27"), 1);
    assert.equal(line('a = "\\q"'), 1);
    assert.equal(line("= 1"), 1);
    assert.equal(line("a = 1\n[x\n"), 2);
  });

  it("does not let a key named __proto__ reach the prototype", () => {
    const table = parseToml('__proto__ = 1\n[x]\n__proto__ = 2');
    assert.equal(Object.getPrototypeOf(table), Object.prototype);
    assert.equal(({} as { polluted?: unknown }).polluted, undefined);
  });
});
