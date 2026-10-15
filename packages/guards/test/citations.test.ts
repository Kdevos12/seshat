import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { knownSorries, presentsAsKnown, referencesIn, resolveReference, unresolvedReferences } from "../src/index.ts";
import { openMemory } from "./helpers.ts";

describe("referencesIn", () => {
  it("reads [cite: ...] markers, several to a marker", () => {
    assert.deepEqual(referencesIn("by [cite: C17] and [cite: L4, src:Smith2019; clm_X]"), [
      { text: "C17", kind: "marker" },
      { text: "L4", kind: "marker" },
      { text: "src:Smith2019", kind: "marker" },
      { text: "clm_X", kind: "marker" },
    ]);
    assert.deepEqual(referencesIn("[cite: ]"), [{ text: "", kind: "marker" }]);
  });

  it("reads external identifiers wherever they stand", () => {
    const found = referencesIn("see arXiv:2101.01234v2, doi:10.1000/xyz123 and OEIS A000045, MR 1234567");
    assert.deepEqual(found.map((r) => [r.kind, r.text]), [
      ["external", "arXiv:2101.01234v2"],
      ["external", "doi:10.1000/xyz123"],
      ["external", "OEIS A000045"],
      ["external", "MR 1234567"],
    ]);
  });

  it("takes an appeal to a known result, with no id, for a reference with no source", () => {
    for (const text of [
      "this is a well-known fact about primes",
      "by the standard theorem on binomials",
      "a known result of the literature",
      "follows from Theorem 3.2 of the survey",
      "as proved by Smith (2019)",
      "by a theorem of Erdős",
      "folklore",
    ]) {
      assert.deepEqual(referencesIn(text).map((r) => r.kind), ["appeal"], text);
    }
    // A marker or an identifier next to the appeal is what gets judged, alone.
    assert.deepEqual(referencesIn("a well-known fact [cite: C1]").map((r) => r.kind), ["marker"]);
    assert.deepEqual(referencesIn("nothing here: simp closes the goal"), []);
  });

  it("sees what presents a statement as known", () => {
    assert.equal(presentsAsKnown("this is a known result"), true);
    assert.equal(presentsAsKnown("see [cite: C1]"), true);
    assert.equal(presentsAsKnown("an easy induction"), false);
  });
});

describe("resolving a reference", () => {
  async function setup() {
    const { memory } = openMemory();
    const { claimId } = await memory.ensureClaim({ statement: "(n : ℕ) : n + 0 = n", origin: "test" });
    const other = await memory.ensureClaim({ statement: "(n : ℕ) : 0 + n = n", origin: "test" });
    const edge = memory.addEdge({ kind: "cites", from: claimId, to: other.claimId });
    const node = memory.recordNode({ kind: "hypothesis", claimId, data: { text: "a guess" } });
    memory.recordNode({
      kind: "source",
      data: { ref: "Smith 2019", title: "On sums", aliases: ["smith2019", "arXiv:2101.01234"], declaration: "Nat.add_zero" },
    });
    memory.recordNode({ kind: "source", data: "a bare string is not a source" });
    return { memory, claimId, edgeId: edge.edgeId, nodeId: node.nodeId };
  }

  it("resolves the ids of the packet and of the graph", async () => {
    const { memory, claimId, edgeId, nodeId } = await setup();
    const env = { memory, packetIds: ["C17", "L4"] };
    assert.equal(await resolveReference("C17", env), "packet");
    assert.equal(await resolveReference(" L4 ", env), "packet");
    assert.equal(await resolveReference(claimId, env), "claim");
    assert.equal(await resolveReference(edgeId, env), "edge");
    assert.equal(await resolveReference(nodeId, env), "node");
    // A well-formed id of the graph that names nothing, and a short id the packet did not show.
    assert.equal(await resolveReference("clm_00000000000000000000000000", env), undefined);
    assert.equal(await resolveReference("C99", env), undefined);
    assert.equal(await resolveReference("", env), undefined);
  });

  it("resolves a reference to a source node by any of its names", async () => {
    const { memory } = await setup();
    for (const ref of ["Smith 2019", "smith  2019", "src:Smith2019", "source: smith2019", "arXiv:2101.01234", "Nat.add_zero", "on sums"]) {
      assert.equal(await resolveReference(ref, { memory }), "source", ref);
    }
    assert.equal(await resolveReference("Jones 2020", { memory }), undefined);
    // `src:` restricts a reference to sources: a graph id with the prefix is no source.
    const { claimId } = await setup();
    assert.equal(await resolveReference(`src:${claimId}`, { memory }), undefined);
  });

  it("resolves a name the project knows as a declaration, when it is told how to ask", async () => {
    const { memory } = await setup();
    const declarationExists = async (name: string) => name === "Nat.succ_le_of_lt";
    assert.equal(await resolveReference("Nat.succ_le_of_lt", { memory, declarationExists }), "declaration");
    assert.equal(await resolveReference("Nat.made_up", { memory, declarationExists }), undefined);
    assert.equal(await resolveReference("Nat.succ_le_of_lt", { memory }), undefined);
    // Only a name is asked, never a phrase.
    assert.equal(await resolveReference("a known fact", { memory, declarationExists: async () => true }), undefined);
  });

  it("lists the references of some passages that resolve to nothing", async () => {
    const { memory } = await setup();
    const env = { memory, packetIds: ["C17"] };
    assert.deepEqual(await unresolvedReferences(["uses [cite: C17]", "plain comment"], env), []);
    assert.deepEqual(
      await unresolvedReferences(["[cite: C17, C99]", "a well-known fact", "see arXiv:1111.2222", "[cite: C99]"], env),
      ["[cite: C99]", "an appeal to a known result, with no source", "arXiv:1111.2222"],
    );
    assert.deepEqual(await unresolvedReferences(["see arXiv:2101.01234"], env), []);
  });
});

describe("a sorry presented as a known result", () => {
  it("is found when a comment above or inside the declaration calls it known", () => {
    const source = [
      "-- this is a well-known result, see the survey",
      "theorem aux_a (n : ℕ) : n + 0 = n := by",
      "  sorry",
      "",
      "theorem aux_b (n : ℕ) : n = n := by",
      "  -- known result [cite: C1]",
      "  sorry",
    ].join("\n");
    assert.deepEqual(knownSorries(source), ["aux_a", "aux_b"]);
  });

  it("is found in a block of a proof that is not a declaration", () => {
    assert.deepEqual(knownSorries("have h : x = 1 := by\n  sorry -- standard result"), ["the proof"]);
  });

  it("is not found when the sorry is plain, or the known result is proved", () => {
    assert.deepEqual(knownSorries("-- the key step\ntheorem aux_a : True := by\n  sorry"), []);
    assert.deepEqual(knownSorries("-- well-known fact\ntheorem aux_a : True := by\n  trivial"), []);
    // The comment belongs to the next declaration only.
    assert.deepEqual(knownSorries("-- well-known\ntheorem aux_a : True := by\n  trivial\n\ntheorem aux_b : True := by\n  sorry"), []);
  });
});
