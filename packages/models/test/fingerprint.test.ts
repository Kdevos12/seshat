import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, Journal } from "@seshat/core";
import { MemoryStore } from "@seshat/memory";
import {
  addPlannedEdges,
  type Battery,
  countVerdicts,
  evaluateMagmaStatement,
  fingerprintsOf,
  type FingerprintData,
  type MagmaObject,
  magmaBattery,
  type MagmaStatement,
  planRelations,
  pointwiseLink,
  recognizeStatement,
  recordBattery,
  recordFingerprint,
  relate,
  verdictString,
} from "../src/index.ts";

const LAWS = {
  leftZero: "∀ x y : M, x * y = x",
  idempotent: "∀ x : M, x * x = x",
  commutative: "∀ x y : M, x * y = y * x",
  associative: "∀ x y z : M, x * y * z = x * (y * z)",
  rowConstant: "∀ x y z : M, x * y = x * z",
  rowConstant2: "∀ x y : M, x * y = x * x",
} as const;

function magmaStatement(law: string): MagmaStatement {
  const result = recognizeStatement(`(M : Type) [Mul M] : ${law}`);
  assert.ok("statement" in result && result.statement.kind === "magma");
  return result.statement;
}

function fingerprint(battery: Battery<MagmaObject>, law: string): string {
  return verdictString(evaluateMagmaStatement(magmaStatement(law), battery.objects).verdicts);
}

/** What the plan needs to know of a battery. */
function shape(battery: Battery): { id: string; size: number } {
  return { id: battery.id, size: battery.objects.length };
}

function open(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), "mh-models-"));
  return new MemoryStore({ journal: Journal.open(dir, "run_1"), blobs: new BlobStore(join(dir, "blobs")) }).withActor("line:M11");
}

describe("comparing fingerprints", () => {
  it("tells equivalence, inclusion and neither, only where the comparison says something", () => {
    assert.equal(relate("1100", "1100"), "equivalent");
    assert.equal(relate("1000", "1100"), "implies");
    assert.equal(relate("1100", "1000"), "implied_by");
    assert.equal(relate("1010", "0110"), "unrelated");
    // A statement that holds everywhere, or nowhere, is related to everything and tells nothing.
    assert.equal(relate("1111", "1111"), "uninformative");
    assert.equal(relate("0000", "0000"), "uninformative");
    assert.equal(relate("0000", "1100"), "uninformative");
    assert.equal(relate("1100", "1111"), "uninformative");
    // No verdict (?) does not count for or against.
    assert.equal(relate("1?00", "1000"), "equivalent");
    assert.equal(relate("10?0", "11?0"), "implies");
    assert.equal(relate("????", "1100"), "uninformative");
    assert.throws(() => relate("10", "100"), /not of one battery/);
    assert.deepEqual(countVerdicts("10?1"), { holds: 2, fails: 1, unknown: 1 });
  });
});

describe("the fingerprints of known laws on the battery of magmas", () => {
  const battery = magmaBattery();
  // The first 1 + 10 + 3330 magmas are all the magmas of size 1 to 3; the others are a sample of size 4.
  const listed = 1 + 10 + 3330;
  const countListed = (law: string) => [...fingerprint(battery, law).slice(0, listed)].filter((c) => c === "1").length;

  it("counts the semigroups, the left-zero magmas and the commutative magmas of size 1 to 3 as the sequences do", () => {
    // 1 + 5 + 24 semigroups of size 1, 2, 3 (OEIS A027851): the associative magmas.
    assert.equal(countListed(LAWS.associative), 1 + 5 + 24);
    // x * y = x has one model of each size.
    assert.equal(countListed(LAWS.leftZero), 3);
    // Commutative magmas, counted without the parser.
    const commutative = battery.objects.slice(0, listed).filter((m) => m.table.every((v, i) => v === m.table[(i % m.size) * m.size + Math.floor(i / m.size)])).length;
    assert.equal(countListed(LAWS.commutative), commutative);
  });

  it("is one character for each object, 1 for a model and 0 for a counter-model", () => {
    const fp = fingerprint(battery, LAWS.associative);
    assert.equal(fp.length, battery.objects.length);
    assert.ok([...fp].every((c) => c === "1" || c === "0"));
    // The first object is the magma of size 1, which satisfies every law.
    assert.equal(fp[0], "1");
    const first = evaluateMagmaStatement(magmaStatement(LAWS.associative), battery.objects);
    const failing = first.verdicts.indexOf(false);
    assert.ok(failing > 0 && first.witnesses[failing]?.length === 3, "a counter-model comes with the values that break the law");
  });

  it("finds the same fingerprint for two forms of one law, and an inclusion for a stronger law", () => {
    assert.equal(fingerprint(battery, LAWS.rowConstant), fingerprint(battery, LAWS.rowConstant2));
    assert.equal(relate(fingerprint(battery, LAWS.rowConstant), fingerprint(battery, LAWS.rowConstant2)), "equivalent");
    assert.equal(relate(fingerprint(battery, LAWS.leftZero), fingerprint(battery, LAWS.associative)), "implies");
    assert.equal(relate(fingerprint(battery, LAWS.leftZero), fingerprint(battery, LAWS.idempotent)), "implies");
    // Neither of these implies the other, and a model of one is a counter-model of the other.
    assert.equal(relate(fingerprint(battery, LAWS.associative), fingerprint(battery, LAWS.commutative)), "unrelated");
    assert.equal(relate(fingerprint(battery, LAWS.idempotent), fingerprint(battery, LAWS.associative)), "unrelated");
  });
});

describe("candidate relations in the memory", () => {
  async function claimsOf(memory: MemoryStore, battery: Battery<MagmaObject>) {
    const out = [];
    for (const [name, law] of Object.entries(LAWS)) {
      const statement = magmaStatement(law);
      const { claimId } = await memory.ensureClaim({ statement: `(M : Type) [Mul M] : ${law}`, origin: "test", gloss: name });
      out.push({ name, claimId, statement, verdicts: fingerprint(battery, law) });
    }
    return out;
  }

  it("records the battery and the fingerprints once, as nodes", async () => {
    const memory = open();
    const battery = magmaBattery({ samples: 20 });
    const { claimId } = await memory.ensureClaim({ statement: `(M : Type) [Mul M] : ${LAWS.associative}`, origin: "test" });
    const node = recordBattery(memory, battery);
    assert.equal(recordBattery(memory, battery).nodeId, node.nodeId);
    assert.deepEqual(node.data, {
      id: "magmas:3+4x20@1",
      family: "magmas",
      digest: battery.digest,
      size: 3361,
      generator: { name: "magmas", params: { exhaustive: 3, sampleSize: 4, samples: 20, seed: 1 } },
    });
    const verdicts = evaluateMagmaStatement(magmaStatement(LAWS.associative), battery.objects).verdicts;
    const fp = recordFingerprint(memory, { claimId, battery, batteryNode: node.nodeId, verdicts, evaluator: "law" });
    assert.equal(recordFingerprint(memory, { claimId, battery, batteryNode: node.nodeId, verdicts, evaluator: "law" }).nodeId, fp.nodeId);
    assert.equal(fp.claimId, claimId);
    const [recorded] = fingerprintsOf(memory, claimId);
    assert.equal((recorded?.data as FingerprintData).verdicts, verdictString(verdicts));
    assert.deepEqual((recorded?.data as FingerprintData).counts, countVerdicts(verdictString(verdicts)));
    assert.equal(memory.nodes("fingerprint").length, 1);
    // Another evaluator's verdicts are another fingerprint.
    recordFingerprint(memory, { claimId, battery, batteryNode: node.nodeId, verdicts, evaluator: "lean" });
    assert.equal(fingerprintsOf(memory, claimId).length, 2);
    assert.equal(memory.claim(claimId)?.status, "open");
  });

  it("proposes `computed` edges: an implication from an inclusion, an equivalence from equal fingerprints", async () => {
    const memory = open();
    const battery = magmaBattery();
    const claims = await claimsOf(memory, battery);
    const byId = new Map(claims.map((c) => [c.claimId, c.name]));
    for (const claim of claims) addPlannedEdges(memory, planRelations(claim, claims, shape(battery)));
    const edges = memory.edges().map((e) => `${e.kind} ${byId.get(e.from)} ${byId.get(e.to[0] as string)} ${e.status}`).sort();
    assert.deepEqual(edges, [
      "equiv rowConstant rowConstant2 computed",
      "implies leftZero associative computed",
      "implies leftZero idempotent computed",
      "implies leftZero rowConstant computed",
      "implies leftZero rowConstant2 computed",
    ]);
    // Nothing is proved: no edge propagates, and no claim has left `open`.
    assert.equal(memory.edges({ minStatus: "lean_checked" }).length, 0);
    assert.ok(claims.every((c) => memory.claim(c.claimId)?.status === "open"));
    // Planning and adding again adds nothing, in either direction for an equivalence.
    for (const claim of [...claims].reverse()) assert.equal(addPlannedEdges(memory, planRelations(claim, claims, shape(battery))).length, 0);
  });

  it("gives an edge the lemma that would make it true, and says it is a candidate", async () => {
    const memory = open();
    const battery = magmaBattery();
    const claims = await claimsOf(memory, battery);
    for (const claim of claims) addPlannedEdges(memory, planRelations(claim, claims, shape(battery)));
    const id = (name: string) => (claims.find((c) => c.name === name) as { claimId: string }).claimId;
    const implication = memory.edges({ from: id("leftZero"), to: id("idempotent") })[0];
    assert.equal(implication?.link?.statement, "(M : Type) [Mul M] (h : ∀ x y : M, x * y = x) : ∀ x : M, x * x = x");
    assert.match(implication?.link?.name ?? "", /^m11_implies_clm_/);
    assert.match(implication?.note ?? "", /candidate implication: in the fingerprints on magmas:3\+4x120@1 \(3461 objects\), the first holds on 3 objects where the second holds on 168/);
    const equivalence = memory.edges({ kinds: ["equiv"] })[0];
    assert.equal(equivalence?.link?.statement, "(M : Type) [Mul M] : (∀ x y z : M, x * y = x * z) ↔ (∀ x y : M, x * y = x * x)");
    assert.match(equivalence?.note ?? "", /candidate equivalence: the fingerprints on magmas:3\+4x120@1 \(3461 objects\) are equal/);
  });

  it("gives no lemma to claims about different structures, and no edge to a claim without a verdict", () => {
    const magma = magmaStatement(LAWS.leftZero);
    const nat = recognizeStatement("(n : ℕ) : n < 5");
    assert.ok("statement" in nat);
    assert.equal(pointwiseLink("implies", magma, nat.statement, "m11_x"), undefined);
    const other = recognizeStatement("{G : Type} [Mul G] : ∀ x : G, x * x = x");
    assert.ok("statement" in other);
    assert.equal(pointwiseLink("implies", magma, other.statement, "m11_x"), undefined);
    const plans = planRelations({ claimId: "a", verdicts: "1000" }, [{ claimId: "b", verdicts: "1100" }, { claimId: "c", verdicts: "????" }], { id: "x", size: 4 });
    assert.deepEqual(plans.map((p) => [p.kind, p.from, p.to, p.link]), [["implies", "a", "b", undefined]]);
  });
});
