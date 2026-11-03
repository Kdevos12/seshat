import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, Journal } from "@seshat/core";
import { MemoryStore } from "@seshat/memory";
import { graphBattery, integerBattery } from "@seshat/models";
import { buildTable, columnValues, DATATABLE_KIND, invariantDependencies, numericColumns, readTables, recordTable } from "../src/index.ts";

function openMemory(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), "ind-table-"));
  return new MemoryStore({ journal: Journal.open(dir, "run_1"), blobs: new BlobStore(join(dir, "blobs")) }).withActor("line:M8");
}

const integers = integerBattery(12, { min: 0 });
const ints = integers.objects.map((o) => (o.kind === "integer" ? o.value : 0));

async function integerTable() {
  return buildTable({
    family: "integers",
    objects: ints,
    objectIds: integers.objects.map((o) => o.id),
    columns: [
      { name: "n", program: "(n) => n" },
      { name: "square", program: "(n) => n * n", lean: "fun n => n ^ 2" },
      { name: "parity", program: "(n) => n % 2 === 0" },
      { name: "twice", program: "(n) => 2 * n" },
      { name: "digits", program: "(n) => String(n).length" },
      { name: "broken", program: "(n) => { if (n === 3) throw new Error('three'); return n; }" },
    ],
  });
}

describe("building a data table", () => {
  it("runs each column's program on every object, in the sandbox, and keeps the code", async () => {
    const table = await integerTable();
    assert.equal(table.family, "integers");
    assert.equal(table.rows.length, 13);
    assert.deepEqual(columnValues(table, "square").slice(0, 5), [0, 1, 4, 9, 16]);
    assert.deepEqual(columnValues(table, "parity").slice(0, 3), [true, false, true]);
    assert.equal(table.columns.find((c) => c.name === "square")?.code, "(n) => n * n");
    assert.equal(table.columns.find((c) => c.name === "square")?.producedBy, "sandbox");
    // A column with a value missing on one object: the others stay.
    assert.equal(columnValues(table, "broken")[3], null);
    assert.equal(table.columns.find((c) => c.name === "broken")?.missing, 1);
    assert.match(table.notes.join("\n"), /column broken: no value on 1 object\(s\), the first because: error: three/);
    // The same objects and code give the same id.
    assert.equal((await integerTable()).id, table.id);
  });

  it("refuses names that are not names, two columns of one name, and a column with both or neither kind of code", async () => {
    const base = { family: "integers", objects: [1], objectIds: ["1"] };
    await assert.rejects(buildTable({ ...base, columns: [{ name: "a b", program: "(n) => n" }] }), /not a short name/);
    await assert.rejects(buildTable({ ...base, columns: [{ name: "a", program: "(n) => n" }, { name: "a", program: "(n) => n" }] }), /given twice/);
    await assert.rejects(buildTable({ ...base, columns: [{ name: "a" }] }), /needs a program or Sage code/);
    await assert.rejects(buildTable({ ...base, columns: [{ name: "a", program: "(n) => n", sage: "o" }] }), /needs a program or Sage code/);
    await assert.rejects(buildTable({ family: "integers", objects: [1, 2], objectIds: ["1"], columns: [] }), /one id for each object/);
  });

  it("computes a column in Sage through the run it is given, and notes when there is none or it fails", async () => {
    const graphs = graphBattery(4).objects;
    const base = { family: "graphs", objects: graphs.map((g) => ({ n: g.n, edges: g.edges })), objectIds: graphs.map((g) => g.graph6), sageObject: "Graph(i)" };
    const calls: string[] = [];
    const sage = async (code: string): Promise<string> => {
      calls.push(code);
      return `'${JSON.stringify(graphs.map((g) => g.edges.length))}'`;
    };
    const table = await buildTable({ ...base, columns: [{ name: "edges", sage: "o.size()" }, { name: "n", program: "(g) => g.n" }], sage });
    assert.equal(calls.length, 1);
    assert.match(calls[0] ?? "", /json\.dumps\(\[\(lambda o: \(o\.size\(\)\)\)\(Graph\(i\)\) for i in \["/);
    assert.deepEqual(columnValues(table, "edges"), graphs.map((g) => g.edges.length));
    assert.equal(table.columns[0]?.producedBy, "sage");

    const without = await buildTable({ ...base, columns: [{ name: "edges", sage: "o.size()" }] });
    assert.equal(columnValues(without, "edges").every((v) => v === null), true);
    assert.match(without.notes.join(), /no SageMath was available/);
    const failing = await buildTable({ ...base, columns: [{ name: "edges", sage: "o.size()" }], sage: async () => "'[1, 2]'" });
    assert.match(failing.notes.join(), /Sage failed: expected 18 values, got 2/);
    const noObject = await buildTable({ family: "graphs", objects: [1], objectIds: ["a"], columns: [{ name: "edges", sage: "o.size()" }], sage });
    assert.match(noObject.notes.join(), /no sageObject/);
  });
});

describe("the numeric columns and the dependencies between invariants", () => {
  it("lists the columns with numbers only", async () => {
    const table = await integerTable();
    assert.deepEqual(numericColumns(table).map((c) => c.name), ["n", "square", "twice", "digits", "broken"]);
  });

  it("finds equal columns, order, functions and monotone relations", async () => {
    const table = await integerTable();
    const found = invariantDependencies(table);
    const has = (kind: string, from: string, to: string) => found.some((d) => d.kind === kind && d.from === from && d.to === to);
    assert.ok(has("determines", "n", "square"));
    assert.ok(has("determines", "square", "n"), "on the numbers from 0 the square determines the number");
    assert.ok(has("at_most", "n", "square"));
    assert.ok(has("at_most", "n", "twice"));
    assert.ok(has("monotone", "n", "digits") || has("determines", "n", "digits"));
    assert.ok(has("monotone", "digits", "n") === false, "the number of digits does not bound the number from either side as a function");
    // n and broken are equal except at 3, where broken has no value: equal on the rows both have.
    assert.ok(has("equal", "broken", "n") || has("equal", "n", "broken"));
    assert.ok(!found.some((d) => d.kind === "determines" && d.to === "parity"), "parity is not a number column");
  });

  it("does not call a column a function of a constant", async () => {
    const table = await buildTable({ family: "integers", objects: [1, 2, 3, 4], objectIds: ["1", "2", "3", "4"], columns: [{ name: "x", program: "(n) => n" }, { name: "one", program: "(n) => 1" }] });
    assert.deepEqual(invariantDependencies(table).filter((d) => d.kind === "determines"), [{ kind: "determines", from: "x", to: "one", rows: 4, distinct: 4 }]);
  });
});

describe("recording a table", () => {
  it("is a datatable node of the claim, with the code, and is read back; a second record of the same table adds nothing", async () => {
    const memory = openMemory();
    const { claimId } = await memory.ensureClaim({ statement: "(n : ℕ) : n < n + 1", origin: "bench:test" });
    const table = await integerTable();
    const first = recordTable(memory, claimId, table, "line:M8");
    assert.equal(first.created, true);
    assert.equal(recordTable(memory, claimId, table, "line:M8").created, false);
    const nodes = memory.nodes(DATATABLE_KIND, { claimId });
    assert.equal(nodes.length, 1);
    const [read] = readTables(memory, claimId);
    assert.deepEqual(read?.table.rows, table.rows);
    assert.deepEqual(read?.table.columns.map((c) => c.code), table.columns.map((c) => c.code));
  });

  it("keeps the rows of a large table in a blob, and reads them back", async () => {
    const memory = openMemory();
    const { claimId } = await memory.ensureClaim({ statement: "(n : ℕ) : n < n + 1", origin: "bench:test" });
    const objects = Array.from({ length: 400 }, (_, i) => i);
    const table = await buildTable({ family: "integers", objects, objectIds: objects.map(String), columns: ["a", "b", "c", "d", "e", "f"].map((name, k) => ({ name, program: `(n) => n * ${k + 1}` })) });
    recordTable(memory, claimId, table, "line:M8");
    const node = memory.nodes(DATATABLE_KIND, { claimId })[0];
    const data = node?.data as { blob?: string; rows?: unknown };
    assert.match(data.blob ?? "", /^[0-9a-f]{64}$/);
    assert.equal(data.rows, undefined);
    assert.deepEqual(readTables(memory, claimId)[0]?.table.rows, table.rows);
  });
});
