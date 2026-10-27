import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { loadCatalog, Registry } from "@seshat/registry";
import {
  canonicalGraph,
  GROUPS_OF_ORDER,
  graphsUpToIso,
  type MagmaObject,
  parsePythonStrings,
  type SageRun,
  sageGraphBattery,
  sageGroupBattery,
  sageThroughRegistry,
  smallGroups,
} from "../src/index.ts";

/** A python list of string literals, as Sage prints it (`repr` escapes the backslash that graph6 may hold). */
function pythonStrings(values: readonly string[]): string {
  return `[${values.map((v) => `'${v.replace(/\\/g, "\\\\")}'`).join(", ")}]`;
}

/** Relabels a group's elements by reversing them, so that its identity is not the first element. */
function reversed(group: MagmaObject): number[][] {
  const n = group.size;
  const perm = Array.from({ length: n }, (_, i) => n - 1 - i);
  const rows = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) (rows[perm[a] as number] as number[])[perm[b] as number] = perm[group.table[a * n + b] as number] as number;
  }
  return rows;
}

describe("batteries read from SageMath", () => {
  it("reads a python list of strings, with escapes", () => {
    assert.deepEqual(parsePythonStrings("['A?', \"B'w\", 'D\\\\{']"), ["A?", "B'w", "D\\{"]);
    assert.deepEqual(parsePythonStrings("[]"), []);
    assert.throws(() => parsePythonStrings("['A?', 'B"), /not a list of strings/);
    assert.throws(() => parsePythonStrings("[1, 2]"), /expected a string literal/);
  });

  it("reads the graphs of geng in slices, and finds the same classes as the TypeScript generator", async () => {
    const asked: string[] = [];
    const geng = graphsUpToIso(7);
    const run: SageRun = async (code) => {
      asked.push(code);
      const [, from, to] = /\]\[(\d+):(\d+)\]$/.exec(code) ?? [];
      return pythonStrings(geng.slice(Number(from), Number(to)).map((g) => g.graph6));
    };
    const battery = await sageGraphBattery(run, { vertices: 7 });
    assert.equal(battery.id, "graphs:geng:7");
    assert.equal(battery.objects.length, 1044);
    assert.deepEqual(asked, [
      '[g.graph6_string() for g in graphs.nauty_geng("7")][0:1000]',
      '[g.graph6_string() for g in graphs.nauty_geng("7")][1000:2000]',
    ]);
    assert.deepEqual(
      new Set(battery.objects.map((g) => canonicalGraph(g).id)),
      new Set(geng.map((g) => g.id)),
    );
    assert.deepEqual(battery.generator, { name: "sage-geng", params: { vertices: 7, flags: "" } });
  });

  it("passes geng's flags, and refuses anything else", async () => {
    const asked: string[] = [];
    const battery = await sageGraphBattery(async (code) => {
      asked.push(code);
      return "['Bw']";
    }, { vertices: 3, flags: "-c -t" });
    assert.equal(battery.id, "graphs:geng:3 -c -t");
    assert.match(asked[0] ?? "", /nauty_geng\("3 -c -t"\)/);
    await assert.rejects(sageGraphBattery(async () => "[]", { vertices: 3, flags: '"; import os' }), /not flags/);
    await assert.rejects(sageGraphBattery(async () => "[]", { vertices: 0 }), /1 to 20 vertices/);
  });

  it("reads the groups of the SmallGroups library as Cayley tables, and checks each one", async () => {
    const asked: string[] = [];
    const known = new Map(smallGroups(8).filter((g) => g.size === 6).map((g) => [g.name, g]));
    const run: SageRun = async (code) => {
      asked.push(code);
      const k = Number(/SmallPermutationGroup\(6, (\d+)\)/.exec(code)?.[1]);
      // SmallGroup(6, 1) is the dihedral group of order 6 and SmallGroup(6, 2) the cyclic one.
      return JSON.stringify(reversed(k === 1 ? (known.get("D3") as MagmaObject) : (known.get("C6") as MagmaObject)));
    };
    const battery = await sageGroupBattery(run, [6]);
    assert.deepEqual(battery.objects.map((g) => g.name), ["SmallGroup(6,1)", "SmallGroup(6,2)"]);
    assert.equal(battery.objects.length, GROUPS_OF_ORDER[5]);
    assert.deepEqual(battery.objects.map((g) => g.identity), [5, 5]);
    assert.equal(battery.id, "groups:sage:6");
    assert.match(asked[0] ?? "", /^grp = SmallPermutationGroup\(6, 1\)\nels = list\(grp\)\n\[\[els.index\(ea \* eb\)/);

    await assert.rejects(sageGroupBattery(async () => "[[0, 0], [0, 0]]", [2]), /not a group/);
    await assert.rejects(sageGroupBattery(async () => "[[0]]", [2]), /expected a 2 x 2 table/);
    await assert.rejects(sageGroupBattery(async () => "[]", [33]), /orders 1 to 32/);
    assert.deepEqual((await sageGroupBattery(async () => "[[0]]", [1])).objects.map((g) => g.size), [1]);
  });
});

// Needs a real SageMath: SAGEMATH_MCP_COMMAND=PATH/TO/sagemath-mcp pnpm test
// (documentation/development.md, "Tests that use real data").
describe("batteries read from a real SageMath", { skip: process.env.SAGEMATH_MCP_COMMAND === undefined ? "set SAGEMATH_MCP_COMMAND to the sagemath-mcp executable" : false }, () => {
  const catalog = loadCatalog(new URL("../../../capabilities", import.meta.url).pathname);
  const registry = new Registry({
    catalog,
    host: {
      host: "test",
      capabilities: { "compute.sage": { use: ["local"], settings: { local: { command: process.env.SAGEMATH_MCP_COMMAND ?? "sagemath-mcp" } } } },
    },
  });
  after(async () => {
    await registry.close();
  });

  it("lists the same graphs as the TypeScript generator", async () => {
    const run = sageThroughRegistry(registry, { scope: "models-test-graphs" });
    const battery = await sageGraphBattery(run, { vertices: 6 });
    assert.equal(battery.objects.length, 156);
    assert.deepEqual(new Set(battery.objects.map((g) => canonicalGraph(g).id)), new Set(graphsUpToIso(6).map((g) => g.id)));
    await registry.release("models-test-graphs");
  });

  it("lists the groups of order 1 to 8 of the SmallGroups library", async () => {
    const run = sageThroughRegistry(registry, { scope: "models-test-groups" });
    const battery = await sageGroupBattery(run, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(battery.objects.length, GROUPS_OF_ORDER.slice(0, 8).reduce((a, b) => a + b, 0));
    await registry.release("models-test-groups");
  });
});
