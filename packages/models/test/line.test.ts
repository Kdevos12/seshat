import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, Journal, type LeanSnippet } from "@seshat/core";
import type { Line, ProblemContext, SessionContext, ValidateRequest, ValidateResult } from "@seshat/lines";
import { MemoryStore } from "@seshat/memory";
import { CapabilityError, type Registry } from "@seshat/registry";
import {
  createM11,
  describeFindings,
  evaluateMagmaStatement,
  fingerprintsOf,
  M11,
  M11_DEFAULTS,
  type M11Options,
  type MagmaStatement,
  magmaBattery,
  neighborClaims,
  negationProofs,
  OeisClient,
  readOptions,
  recognizeStatement,
  verdictString,
} from "../src/index.ts";
import { SimulatedDecide } from "./simulated-lean.ts";

const LEFT_PROJECTION_COMMUTES = "(M : Type*) [Mul M] (h : ∀ x y : M, x * y = x) : ∀ x y : M, x * y = y * x";
const LEFT_PROJECTION_ASSOCIATES = "(M : Type*) [Mul M] (h : ∀ x y : M, x * y = x) : ∀ x y z : M, x * (y * z) = (x * y) * z";
const CONSTANT_IN_Y = "(M : Type) [Mul M] : ∀ x y z : M, x * y = x * z";
const SQUARE_IS_PRODUCT = "(M : Type) [Mul M] : ∀ x y : M, x * y = x * x";
const LEFT_PROJECTION = "(M : Type) [Mul M] : ∀ x y : M, x * y = x";
const EVEN = "(n : ℕ) : n % 2 = 0";
const COMMUTATIVE = "(M : Type) [Mul M] : ∀ x y : M, x * y = y * x";

function openMemory(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), "mh-line-"));
  return new MemoryStore({ journal: Journal.open(dir, "run_1"), blobs: new BlobStore(join(dir, "blobs")) }).withActor("line:M11");
}

/** A call of a capability other than `lean.check`. */
interface RegistryCall {
  name: string;
  input: unknown;
  options: unknown;
}

/**
 * A registry whose `lean.check` is the simulated `decide`: enough for `RegistryLeanChecker`. The other
 * capabilities it offers are the ones given, by name; a host that offers none says `unavailable`.
 */
function registryOf(lean: SimulatedDecide, others: Readonly<Record<string, (input: unknown) => unknown>> = {}, calls: RegistryCall[] = []): Registry {
  return {
    hash: "0".repeat(64),
    invoke: async (name: string, input: unknown, options: unknown) => {
      if (name === "lean.check") return { output: { results: await lean.check((input as { snippets: LeanSnippet[] }).snippets) } };
      calls.push({ name, input, options });
      const answer = others[name];
      if (answer === undefined) throw new CapabilityError("unavailable", name, `host test does not offer ${name}`);
      return { output: answer(input) };
    },
  } as unknown as Registry;
}

const valid: ValidateResult = { verdict: "valid", status: "open", reasons: [], validationId: "val_1" };
const invalid: ValidateResult = { verdict: "invalid", status: "open", reasons: ["unsolved goals"] };

interface Setup {
  options?: Partial<M11Options>;
  validate?: (request: ValidateRequest, calls: number) => ValidateResult;
  lean?: SimulatedDecide;
  /** Capabilities other than `lean.check` that the host offers, by name. */
  capabilities?: Readonly<Record<string, (input: unknown) => unknown>>;
  memory?: MemoryStore;
  statement?: string;
}

async function problemOf(statement: string, setup: Setup = {}) {
  const memory = setup.memory ?? openMemory();
  const { claimId } = await memory.ensureClaim({ statement, origin: "bench:test" });
  const logs: string[] = [];
  const requests: ValidateRequest[] = [];
  const calls: RegistryCall[] = [];
  const options = { ...M11_DEFAULTS, ...setup.options };
  const problem = {
    line: "M11",
    runId: "run_1",
    problemId: "p1",
    claimId,
    target: { theorem: "T.t", statement, source: "", sketch: { prefix: "import Mathlib\n" } },
    domain: [],
    memory,
    registry: registryOf(setup.lean ?? new SimulatedDecide({ truth: () => true }), setup.capabilities, calls),
    validate: async (request: ValidateRequest) => {
      requests.push(request);
      return (setup.validate ?? (() => valid))(request, requests.length);
    },
    log: (text: string) => logs.push(text),
    signal: new AbortController().signal,
    options,
  } as unknown as ProblemContext;
  return { problem, memory, claimId, logs, requests, calls };
}

const hook = <K extends keyof Line["hooks"]>(line: Line, name: K): NonNullable<Line["hooks"][K]> => {
  const found = line.hooks[name];
  assert.ok(found !== undefined, `the line has a ${name} hook`);
  return found;
};

const statementOf = (text: string): MagmaStatement => {
  const result = recognizeStatement(text);
  assert.ok("statement" in result && result.statement.kind === "magma");
  return result.statement;
};

describe("the options of the line", () => {
  it("have a default for each, of the type the run must keep", () => {
    assert.deepEqual(readOptions(M11_DEFAULTS), M11_DEFAULTS);
    assert.equal(M11.id, "M11");
    assert.deepEqual(M11.options, M11_DEFAULTS);
    assert.deepEqual(M11.requires, []);
    assert.equal(M11.title, "small models and fingerprints: certified refutations, candidate equivalences");
  });

  it("are checked when a hook reads them, with the name of the option", () => {
    assert.throws(() => readOptions({ ...M11_DEFAULTS, exhaustive: 4 }), /option M11\.exhaustive is an integer from 0 to 3, not 4/);
    assert.throws(() => readOptions({ ...M11_DEFAULTS, maxNumber: "100" }), /option M11\.maxNumber is an integer from 1 to 1000, not "100"/);
    assert.throws(() => readOptions({ ...M11_DEFAULTS, refute: 1 }), /option M11\.refute is true or false, not 1/);
    // oeis.search takes at most 100 terms: a longer lookup would be refused by the registry and fail the problem.
    assert.throws(() => readOptions({ ...M11_DEFAULTS, identifyTerms: 101 }), /option M11\.identifyTerms is an integer from 4 to 100, not 101/);
    assert.throws(() => readOptions({ ...M11_DEFAULTS, identifyTerms: 150 }), /option M11\.identifyTerms/);
    assert.equal(readOptions({ ...M11_DEFAULTS, identifyTerms: 100 }).identifyTerms, 100);
    // The caps on what a problem may spend: how many files Lean gets, how many assignments the law evaluator tries.
    assert.equal(M11_DEFAULTS.leanFiles, 200);
    assert.equal(M11_DEFAULTS.lawWork, 60_000_000);
    assert.throws(() => readOptions({ ...M11_DEFAULTS, leanFiles: -1 }), /option M11\.leanFiles is an integer from 0 to 10000, not -1/);
    assert.throws(() => readOptions({ ...M11_DEFAULTS, lawWork: 1.5 }), /option M11\.lawWork is an integer from 0 to 10000000000, not 1\.5/);
    assert.equal(readOptions({ ...M11_DEFAULTS, leanFiles: 0, lawWork: 0 }).leanFiles, 0);
    assert.throws(() => readOptions({ ...M11_DEFAULTS, samples: 1.5 }), /option M11\.samples/);
    const { stopWhenRefuted: _, ...missing } = M11_DEFAULTS;
    assert.throws(() => readOptions(missing), /option M11\.stopWhenRefuted is true or false, not undefined/);
  });
});

describe("beforeProvers on a statement of magmas", () => {
  it("fingerprints a false statement, records its counter-model and submits the negation through validate", async () => {
    const { problem, memory, claimId, logs, requests } = await problemOf(LEFT_PROJECTION_COMMUTES);
    await hook(M11, "beforeProvers")(problem);

    const battery = magmaBattery();
    const expected = verdictString(evaluateMagmaStatement(statementOf(LEFT_PROJECTION_COMMUTES), battery.objects).verdicts);
    const [fingerprint] = fingerprintsOf(memory, claimId);
    assert.equal(fingerprintsOf(memory, claimId).length, 1);
    assert.deepEqual([fingerprint?.data.battery, fingerprint?.data.digest, fingerprint?.data.evaluator], ["magmas:3+4x120@1", battery.digest, "law"]);
    assert.equal(fingerprint?.data.verdicts, expected);
    assert.equal(battery.objects.length, 1 + 10 + 3330 + 120);
    // The left projection of 2 and of 3 elements are the two exhaustive magmas that break it.
    assert.equal([...expected.slice(0, 3341)].filter((c) => c === "0").length, 2);
    assert.equal(memory.nodes("battery").length, 1);

    // One counter-model, the smallest, and its negation, sent as the line's `validate`.
    const [counterModel, ...more] = memory.nodes("counter_model", { claimId });
    assert.equal(more.length, 0);
    const data = counterModel?.data as { index: number; object: { size: number; table: number[] }; refutation: Array<{ form: string; verdict: string }> };
    assert.deepEqual(data.object, { kind: "magma", size: 2, table: [0, 0, 1, 1] });
    assert.deepEqual(data.refutation.map((a) => [a.form, a.verdict]), [["have-revert", "valid"]]);
    assert.equal(requests.length, 1);
    assert.deepEqual({ ...requests[0], proof: undefined }, { claimId, negation: true, proof: undefined });
    assert.equal(requests[0]?.proof, negationProofs(statementOf(LEFT_PROJECTION_COMMUTES), { kind: "magma", id: "2:0011", size: 2, table: [0, 0, 1, 1] })[0]?.proof);

    // Computed, never lean_checked, and the claim is as it was: only the certifier refutes.
    const [edge] = memory.edges({ from: claimId, kinds: ["refuted_by"] });
    assert.deepEqual([edge?.status, edge?.to], ["computed", [counterModel?.nodeId]]);
    assert.equal(memory.claim(claimId)?.status, "open");
    assert.match(logs.join("\n"), /M11: on magmas:3\+4x120@1 \(3461 objects\) the statement holds on \d+, fails on \d+, no verdict on 0/);
    assert.match(logs.join("\n"), /the statement fails on the magma of size 2 with the table \[\[0,0\],\[1,1\]\]/);
    assert.match(logs.join("\n"), /a proof of the negation passed the fast check \(have-revert, validation val_1\); the claim is open until the certifier replays it/);
  });

  it("sends the second form of the proof, then the next counter-model, when Lean does not accept the first", async () => {
    const { problem, memory, claimId, requests, logs } = await problemOf(LEFT_PROJECTION_COMMUTES, { options: { counterModels: 2 }, validate: () => invalid });
    await hook(M11, "beforeProvers")(problem);
    assert.equal(requests.length, 4);
    assert.deepEqual(requests.map((r) => r.aux !== undefined), [false, true, false, true]);
    assert.notEqual(requests[0]?.proof, requests[2]?.proof);
    const counterModels = memory.nodes("counter_model", { claimId });
    assert.equal(counterModels.length, 2);
    for (const node of counterModels) {
      assert.deepEqual((node.data as { refutation: Array<{ verdict: string }> }).refutation.map((a) => a.verdict), ["invalid", "invalid"]);
    }
    assert.match(logs.join("\n"), /Lean did not accept the proofs of the negation \(unsolved goals \| unsolved goals\)/);
    assert.equal(memory.claim(claimId)?.status, "open");
  });

  it("stops at the first counter-model whose negation passes", async () => {
    const { problem, memory, claimId, requests } = await problemOf(LEFT_PROJECTION_COMMUTES, { validate: (_r, calls) => (calls < 3 ? invalid : valid) });
    await hook(M11, "beforeProvers")(problem);
    // Two forms for the first counter-model fail; the first form for the second passes.
    assert.equal(requests.length, 3);
    assert.equal(memory.nodes("counter_model", { claimId }).length, 2);
  });

  it("records the counter-model and submits nothing when refute is off", async () => {
    const { problem, memory, claimId, requests } = await problemOf(LEFT_PROJECTION_COMMUTES, { options: { refute: false } });
    await hook(M11, "beforeProvers")(problem);
    assert.equal(requests.length, 0);
    const nodes = memory.nodes("counter_model", { claimId });
    assert.equal(nodes.length, 1);
    assert.equal((nodes[0]?.data as { refutation?: unknown }).refutation, undefined);
  });

  it("records only the fingerprint of a statement with no counter-model", async () => {
    const { problem, memory, claimId, requests } = await problemOf(LEFT_PROJECTION_ASSOCIATES);
    await hook(M11, "beforeProvers")(problem);
    assert.equal(requests.length, 0);
    assert.deepEqual(memory.nodes("counter_model", { claimId }), []);
    assert.equal(fingerprintsOf(memory, claimId)[0]?.data.counts.fails, 0);
    assert.deepEqual(memory.edges({ from: claimId, kinds: ["refuted_by"] }), []);
    assert.match(describeFindings(memory, claimId) ?? "", /No counter-model among them: this is evidence for the statement, and no proof of it\./);
  });

  it("leaves a statement of another shape alone, and says so", async () => {
    const { problem, memory, claimId, logs, requests } = await problemOf("(G : Type*) [Group G] (a b : G) : a * b = b * a");
    await hook(M11, "beforeProvers")(problem);
    assert.deepEqual([fingerprintsOf(memory, claimId), memory.nodes("battery"), requests], [[], [], []]);
    assert.match(logs.join("\n"), /^M11: the statement is left alone: /);
  });

  it("fails with the name of the option when a run gave a value out of range", async () => {
    const { problem } = await problemOf(LEFT_PROJECTION_COMMUTES, { options: { exhaustive: 9 } });
    await assert.rejects(hook(M11, "beforeProvers")(problem), /option M11\.exhaustive is an integer from 0 to 3, not 9/);
  });

  it("uses the battery the options give", async () => {
    const { problem, memory, claimId } = await problemOf(LEFT_PROJECTION_ASSOCIATES, { options: { exhaustive: 2, samples: 0 } });
    await hook(M11, "beforeProvers")(problem);
    const [fingerprint] = fingerprintsOf(memory, claimId);
    assert.deepEqual([fingerprint?.data.battery, fingerprint?.data.verdicts.length], ["magmas:2", 11]);
  });
});

describe("the claims around the problem's", () => {
  it("are found by following edges, in both directions, nearest first and at most so many", async () => {
    const memory = openMemory();
    const claim = async (statement: string) => (await memory.ensureClaim({ statement, origin: "test" })).claimId;
    const a = await claim(CONSTANT_IN_Y);
    const b = await claim(SQUARE_IS_PRODUCT);
    const c = await claim(LEFT_PROJECTION);
    const d = await claim(LEFT_PROJECTION_ASSOCIATES);
    const e = await claim(EVEN);
    memory.addEdge({ kind: "special_case_of", from: a, to: b });
    memory.addEdge({ kind: "implies", from: c, to: a });
    memory.addEdge({ kind: "strengthens", from: d, to: c });
    memory.addEdge({ kind: "uses", from: a, to: e });
    const ids = (depth: number, limit: number) => neighborClaims(memory, a, depth, limit).map((x) => x.claimId);
    assert.deepEqual(ids(1, 10), [b, c]);
    assert.deepEqual(ids(2, 10), [b, c, d]);
    assert.deepEqual(ids(2, 2), [b, c]);
    assert.deepEqual(ids(3, 0), []);
    // `uses` is provenance, not a relation between statements.
    assert.ok(!ids(4, 10).includes(e));
  });

  it("get their fingerprints, and the candidate edges among them become computed edges with a link lemma", async () => {
    const { problem, memory, claimId, logs } = await problemOf(CONSTANT_IN_Y);
    const claim = async (statement: string) => (await memory.ensureClaim({ statement, origin: "line:M2", parentId: claimId })).claimId;
    const equivalent = await claim(SQUARE_IS_PRODUCT);
    const stronger = await claim(LEFT_PROJECTION);
    const other = await claim(EVEN);
    // What another line recorded: the stronger statement is a variant; the equivalent one was proposed.
    memory.addEdge({ kind: "special_case_of", from: stronger, to: claimId, status: "proposed" });
    memory.addEdge({ kind: "equiv", from: claimId, to: equivalent, status: "proposed" });
    memory.addEdge({ kind: "strengthens", from: claimId, to: other, status: "proposed" });
    await hook(M11, "beforeProvers")(problem);

    // The problem's claim, its two variants of magmas, and no fingerprint for the statement about numbers.
    assert.equal(fingerprintsOf(memory, equivalent).length, 1);
    assert.equal(fingerprintsOf(memory, stronger).length, 1);
    assert.equal(fingerprintsOf(memory, other).length, 0);
    assert.equal(memory.nodes("battery").length, 1);
    const computed = (kind: "equiv" | "implies") => memory.edges({ kinds: [kind] }).filter((e) => e.status === "computed");
    // The proposed equivalence is not repeated; the inclusions are new.
    assert.deepEqual(computed("equiv"), []);
    const implies = computed("implies").map((e) => [e.from, e.to[0]]).sort();
    assert.deepEqual(implies, [[stronger, claimId], [stronger, equivalent]].sort());
    const toProblem = computed("implies").find((e) => e.from === stronger && e.to[0] === claimId);
    assert.match(toProblem?.note ?? "", /^candidate implication: in the fingerprints on magmas:3\+4x120@1 \(3461 objects\)/);
    assert.deepEqual(toProblem?.link, {
      name: `m11_implies_${stronger}_${claimId}`,
      statement: "(M : Type) [Mul M] (h : ∀ x y : M, x * y = x) : ∀ x y z : M, x * y = x * z",
    });
    assert.match(logs.join("\n"), /M11: 2 related claims compared, 2 candidate edges recorded/);
    // Everything is computed: the line never makes an edge lean_checked.
    assert.ok(memory.edges().every((e) => e.status !== "lean_checked"));
  });

  it("are left out when the problem's statement is about a number and theirs about magmas, or when they are informal", async () => {
    const { problem, memory, claimId } = await problemOf(EVEN, { options: { maxNumber: 20 } });
    const magma = (await memory.ensureClaim({ statement: LEFT_PROJECTION, origin: "line:M2" })).claimId;
    const informal = (await memory.ensureClaim({ statement: "every even number is the sum of two primes", origin: "line:M2", kind: "informal" })).claimId;
    memory.addEdge({ kind: "special_case_of", from: magma, to: claimId });
    memory.addEdge({ kind: "special_case_of", from: informal, to: claimId });
    await hook(M11, "beforeProvers")(problem);
    assert.deepEqual([fingerprintsOf(memory, magma), fingerprintsOf(memory, informal)], [[], []]);
  });

  it("are not tried again when they already have a fingerprint of this battery", async () => {
    const { problem, memory, claimId } = await problemOf(CONSTANT_IN_Y);
    const equivalent = (await memory.ensureClaim({ statement: SQUARE_IS_PRODUCT, origin: "line:M2" })).claimId;
    memory.addEdge({ kind: "special_case_of", from: equivalent, to: claimId });
    await hook(M11, "beforeProvers")(problem);
    await hook(M11, "beforeProvers")(problem);
    assert.equal(fingerprintsOf(memory, equivalent).length, 1);
    assert.equal(fingerprintsOf(memory, claimId).length, 1);
    assert.equal(memory.nodes("battery").length, 1);
    assert.equal(memory.edges({ kinds: ["equiv"] }).length, 1);
  });
});

describe("beforeProvers on a statement about a number", () => {
  const evens = new SimulatedDecide({ truth: (i) => (i.kind === "nat" ? i.value % 2 === 0 : undefined) });

  it("tries it with decide in Lean, submits the smallest counter-model and looks the numbers up as sequences", async () => {
    const { problem, memory, claimId, requests } = await problemOf(EVEN, { options: { maxNumber: 60 }, lean: evens });
    await hook(M11, "beforeProvers")(problem);
    const [fingerprint] = fingerprintsOf(memory, claimId);
    assert.deepEqual([fingerprint?.data.battery, fingerprint?.data.evaluator, fingerprint?.data.counts], ["integers:0..60", "lean", { holds: 31, fails: 30, unknown: 0 }]);
    assert.equal(fingerprint?.data.verdicts.slice(0, 6), "101010");
    assert.ok(evens.calls.length > 0 && evens.calls.every((s) => /example : (¬ )?@m11_stmt \d+ := by decide/.test(s.code)));
    assert.match(evens.calls[0]?.code ?? "", /^import Mathlib\n\nabbrev m11_stmt \(n : Nat\) : Prop := n % 2 = 0\n/);

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.proof, "intro hall\nhave key := @hall 1\nrevert key\ndecide");
    const [counterModel] = memory.nodes("counter_model", { claimId });
    assert.deepEqual((counterModel?.data as { object: unknown }).object, { kind: "integer", value: 1 });

    const identifications = memory.nodes("identification", { claimId }).map((n) => n.data as { subject: string; query: string[]; strength: string; matches: Array<{ id: string }> });
    assert.deepEqual(identifications.map((d) => [d.subject, d.matches[0]?.id, d.strength]), [
      ["the numbers from 0 to 60 where the statement holds", "A005843", "strong"],
      ["the numbers from 0 to 60 where the statement fails", "A005408", "strong"],
    ]);
    assert.deepEqual(identifications[0]?.query.slice(0, 5), ["0", "2", "4", "6", "8"]);
    assert.equal(identifications[0]?.query.length, 31);
    for (const edge of memory.edges({ from: claimId, kinds: ["cites"] })) assert.equal(edge.status, "computed");
    assert.equal(memory.claim(claimId)?.status, "open");

    const findings = describeFindings(memory, claimId) ?? "";
    assert.match(findings, /tried on 61 small objects \(battery integers:0\.\.60, by `decide` in Lean\): it holds on 31, fails on 30\./);
    assert.match(findings, /A counter-model: the number 1\./);
    assert.match(findings, /The numbers from 0 to 60 where the statement holds begin 0, 2, 4, 6, 8, 10, 12, 14 and so on\. They match A005843, "The even numbers: a\(n\) = 2n\.", which goes on 62, 64, 66, 68, 70\. This is a strong match, a lookup and no proof/);
  });

  it("asks the OEIS only for what the table does not know, when a client is given", async () => {
    const requested: string[] = [];
    const oeis = new OeisClient({
      minIntervalMs: 0,
      fetch: (async (input: string | URL | Request) => {
        const url = String(input);
        requested.push(url);
        // A made-up sequence for the numbers that are 2 modulo 7; nothing for the others.
        return new Response(
          JSON.stringify(
            url.includes("q=2%2C9%2C16")
              ? { count: 1, results: [{ number: 999999, data: "0,2,9,16,23,30,37,44,51", name: "Numbers that are 2 mod 7, with 0 in front (made up for the test).", offset: "1,2" }] }
              : { count: 0, results: null },
          ),
        );
      }) as typeof fetch,
    });
    // The even numbers and the odd ones are in the table: strong matches, and no request.
    const known = await problemOf(EVEN, { options: { maxNumber: 40, refute: false }, lean: evens });
    await hook(createM11({ oeis }), "beforeProvers")(known.problem);
    assert.deepEqual(requested, []);
    assert.equal(known.memory.nodes("identification", { claimId: known.claimId }).length, 2);

    const sevenths = new SimulatedDecide({ truth: (i) => (i.kind === "nat" ? i.value % 7 === 2 : undefined) });
    const unknown = await problemOf("(n : ℕ) : n % 7 = 2", { options: { maxNumber: 40, refute: false }, lean: sevenths });
    await hook(createM11({ oeis }), "beforeProvers")(unknown.problem);
    assert.equal(requested.length, 2);
    assert.match(requested[0] ?? "", /^https:\/\/oeis\.org\/search\?q=2%2C9%2C16%2C23%2C30%2C37&fmt=json$/);
    const nodes = unknown.memory.nodes("identification", { claimId: unknown.claimId });
    assert.equal(nodes.length, 1);
    const data = nodes[0]?.data as { subject: string; matches: Array<{ id: string; source: string; start: number | null }> };
    assert.equal(data.subject, "the numbers from 0 to 40 where the statement holds");
    assert.deepEqual(data.matches.map((m) => [m.id, m.source, m.start]), [["A999999", "oeis", 2]]);
    // Without a client the same lookup finds nothing: the table does not have it.
    const alone = await problemOf("(n : ℕ) : n % 7 = 2", { options: { maxNumber: 40, refute: false }, lean: sevenths });
    await hook(M11, "beforeProvers")(alone.problem);
    assert.deepEqual(alone.memory.nodes("identification"), []);
  });

  it("asks the registry's oeis.search for what the table does not know, and goes on without it when the host does not offer it", async () => {
    const sevenths = new SimulatedDecide({ truth: (i) => (i.kind === "nat" ? i.value % 7 === 2 : undefined) });
    // The answer of the capability: a made-up sequence for the numbers that are 2 modulo 7, nothing for the others.
    const oeisSearch = (input: unknown) =>
      (input as { terms: string[] }).terms.join(",").startsWith("2,9,16")
        ? {
            count: 1,
            url: "https://oeis.org/search?q=2%2C9%2C16&fmt=json",
            results: [
              { id: "A999999", name: "Numbers that are 2 mod 7, with 0 in front (made up for the test).", offset: 1, terms: ["0", "2", "9", "16", "23", "30", "37", "44", "51"], keywords: ["nonn"], url: "https://oeis.org/A999999" },
            ],
          }
        : { count: 0, url: "https://oeis.org/search?q=0%2C1%2C3&fmt=json", results: [] };
    const offered = await problemOf("(n : ℕ) : n % 7 = 2", { options: { maxNumber: 40, refute: false }, lean: sevenths, capabilities: { "oeis.search": oeisSearch } });
    await hook(M11, "beforeProvers")(offered.problem);
    assert.equal(offered.calls.length, 2, "the numbers where the statement holds, and those where it fails");
    assert.deepEqual(offered.calls[0]?.input, { terms: ["2", "9", "16", "23", "30", "37"] });
    assert.equal((offered.calls[0]?.options as { actor: string }).actor, "line:M11");
    const nodes = offered.memory.nodes("identification", { claimId: offered.claimId });
    assert.equal(nodes.length, 1);
    const data = nodes[0]?.data as { matches: Array<{ id: string; source: string; start: number | null; next: string[] }> };
    assert.deepEqual(data.matches.map((m) => [m.id, m.source, m.start]), [["A999999", "oeis", 2]]);

    // The table's sequences are not asked for again.
    const known = await problemOf(EVEN, { options: { maxNumber: 40, refute: false }, lean: evens, capabilities: { "oeis.search": oeisSearch } });
    await hook(M11, "beforeProvers")(known.problem);
    assert.deepEqual(known.calls, []);

    // A host that does not offer the capability: the lookup is asked for, fails as a lookup does, and the table has nothing.
    const absent = await problemOf("(n : ℕ) : n % 7 = 2", { options: { maxNumber: 40, refute: false }, lean: sevenths });
    await hook(M11, "beforeProvers")(absent.problem);
    assert.equal(absent.calls.length, 2);
    assert.deepEqual(absent.memory.nodes("identification"), []);
    assert.ok(
      absent.logs.some((l) => l.includes("the OEIS did not answer (oeis.search: host test does not offer oeis.search)")),
      absent.logs.join("\n"),
    );
    assert.equal(fingerprintsOf(absent.memory, absent.claimId).length, 1, "the fingerprint is recorded all the same");
  });

  it("does not look up a statement that holds for every number, for too few, or from some number on", async () => {
    const all = await problemOf("(n : ℕ) : n + 0 = n", { options: { maxNumber: 30 }, lean: new SimulatedDecide({ truth: () => true }) });
    await hook(M11, "beforeProvers")(all.problem);
    assert.deepEqual(all.memory.nodes("identification"), []);
    assert.equal(fingerprintsOf(all.memory, all.claimId)[0]?.data.counts.fails, 0);
    const few = await problemOf("(n : ℕ) : n < 3", { options: { maxNumber: 30, refute: false }, lean: new SimulatedDecide({ truth: (i) => (i.kind === "nat" ? i.value < 3 : undefined) }) });
    await hook(M11, "beforeProvers")(few.problem);
    // Three numbers hold, 28 fail: the failing set is long enough, and is 3, 4, 5, ...: from 3 on, which says nothing about a sequence.
    assert.deepEqual(few.memory.nodes("identification"), []);
  });

  it("records nothing when decide settles none of the first numbers", async () => {
    const { problem, memory, claimId, logs } = await problemOf(EVEN, { lean: new SimulatedDecide({ truth: () => undefined }) });
    await hook(M11, "beforeProvers")(problem);
    assert.deepEqual([fingerprintsOf(memory, claimId), memory.nodes("battery"), memory.nodes("counter_model")], [[], [], []]);
    assert.match(logs.join("\n"), /M11: the statement could not be tried: decide settles none of the first 16 objects/);
  });

  it("keeps the numbers decide did not settle as no verdict", async () => {
    const lean = new SimulatedDecide({ truth: (i) => (i.kind === "nat" ? (i.value === 7 ? undefined : i.value % 2 === 0) : undefined) });
    const { problem, memory, claimId } = await problemOf(EVEN, { options: { maxNumber: 20, refute: false }, lean });
    await hook(M11, "beforeProvers")(problem);
    const [fingerprint] = fingerprintsOf(memory, claimId);
    assert.equal(fingerprint?.data.verdicts.charAt(7), "?");
    assert.deepEqual(fingerprint?.data.counts, { holds: 11, fails: 9, unknown: 1 });
  });
});

describe("the caps on what a problem may spend", () => {
  const evens = () => new SimulatedDecide({ truth: (i) => (i.kind === "nat" ? i.value % 2 === 0 : undefined) });

  it("share the Lean files among the problem's statement and the claims around it", async () => {
    const lean = evens();
    const { problem, memory, claimId, logs } = await problemOf(EVEN, { lean, options: { leanFiles: 20, refute: false, identify: false } });
    const neighbors: string[] = [];
    for (const statement of ["(n : ℕ) : n % 4 = 0", "(n : ℕ) : n % 3 = 0", "(n : ℕ) : n % 5 = 0"]) {
      const id = (await memory.ensureClaim({ statement, origin: "line:M2" })).claimId;
      memory.addEdge({ kind: "special_case_of", from: id, to: claimId });
      neighbors.push(id);
    }
    await hook(M11, "beforeProvers")(problem);
    // Each statement takes 11 files on the 101 numbers: the cap runs out in the second.
    assert.equal(lean.calls.length, 20);
    assert.equal(fingerprintsOf(memory, claimId).length, 1);
    // A claim the cap cut short is not recorded: a fingerprint with holes would be compared as if it were whole.
    assert.deepEqual(neighbors.map((id) => fingerprintsOf(memory, id).length), [0, 0, 0]);
    const log = logs.join("\n");
    assert.match(log, /M11: claim \w+ could not be tried: the cap of 20 Lean files \(option M11\.leanFiles\) was reached; \d+ objects have no verdict/);
    assert.equal((log.match(/could not be tried: the cap of 20 Lean files/g) ?? []).length, 3);
  });

  it("say in the log when the problem's own statement is cut short, and keep the verdicts it has", async () => {
    const lean = evens();
    const { problem, memory, claimId, logs } = await problemOf(EVEN, { lean, options: { leanFiles: 9, refute: false, identify: false } });
    await hook(M11, "beforeProvers")(problem);
    assert.equal(lean.calls.length, 9);
    const [fingerprint] = fingerprintsOf(memory, claimId);
    assert.ok((fingerprint?.data.counts.unknown ?? 0) > 0);
    assert.ok((fingerprint?.data.counts.holds ?? 0) > 0);
    assert.match(logs.join("\n"), /M11: the cap of 9 Lean files \(option M11\.leanFiles\) was reached; \d+ objects have no verdict/);
  });

  it("do not try a statement of magmas whose laws would take more assignments than the cap leaves", async () => {
    // h: 2 variables, conclusion: 3. On the 3 461 magmas of the default battery that is 2 + 120 + 119 880 + 9 600 = 129 602 assignments.
    const refused = await problemOf(LEFT_PROJECTION_ASSOCIATES, { options: { lawWork: 129_601 } });
    await hook(M11, "beforeProvers")(refused.problem);
    assert.deepEqual([fingerprintsOf(refused.memory, refused.claimId), refused.memory.nodes("battery")], [[], []]);
    assert.match(refused.logs.join("\n"), /M11: the statement could not be tried: the law evaluator would try up to 129602 assignments of the variables, over the 129601 that the cap \(option M11\.lawWork\) leaves for it/);
    assert.equal(refused.requests.length, 0);

    // A cap that equals the work is enough.
    const allowed = await problemOf(LEFT_PROJECTION_ASSOCIATES, { options: { lawWork: 129_602 } });
    await hook(M11, "beforeProvers")(allowed.problem);
    assert.equal(fingerprintsOf(allowed.memory, allowed.claimId).length, 1);
  });

  it("share the law work among the problem's statement and the claims around it", async () => {
    // 97 671 assignments for the problem's x * y = x * z, 31 931 for each of the two variants of two variables.
    const { problem, memory, claimId, logs } = await problemOf(CONSTANT_IN_Y, { options: { lawWork: 140_000 } });
    const first = (await memory.ensureClaim({ statement: SQUARE_IS_PRODUCT, origin: "line:M2" })).claimId;
    const second = (await memory.ensureClaim({ statement: LEFT_PROJECTION, origin: "line:M2" })).claimId;
    memory.addEdge({ kind: "special_case_of", from: first, to: claimId });
    memory.addEdge({ kind: "special_case_of", from: second, to: claimId });
    await hook(M11, "beforeProvers")(problem);
    assert.equal(fingerprintsOf(memory, claimId).length, 1);
    assert.equal([first, second].filter((id) => fingerprintsOf(memory, id).length === 1).length, 1);
    assert.equal((logs.join("\n").match(/could not be tried: the law evaluator would try up to 31931 assignments of the variables, over the 10398 that the cap \(option M11\.lawWork\) leaves for it/g) ?? []).length, 1);
  });
});

describe("what the provers are told", () => {
  it("is nothing for a claim the line did not try", async () => {
    const memory = openMemory();
    const { claimId } = await memory.ensureClaim({ statement: EVEN, origin: "test" });
    assert.equal(describeFindings(memory, claimId), undefined);
    const session = { memory, claimId, options: M11_DEFAULTS } as unknown as SessionContext;
    assert.equal(await hook(M11, "briefing")(session), undefined);
  });

  it("is a section of the briefing that says what was found, and what is only a candidate", async () => {
    const { problem, memory, claimId } = await problemOf(CONSTANT_IN_Y);
    const equivalent = (await memory.ensureClaim({ statement: SQUARE_IS_PRODUCT, origin: "line:M2" })).claimId;
    const stronger = (await memory.ensureClaim({ statement: LEFT_PROJECTION, origin: "line:M2" })).claimId;
    memory.addEdge({ kind: "special_case_of", from: stronger, to: claimId });
    memory.addEdge({ kind: "special_case_of", from: equivalent, to: claimId });
    await hook(M11, "beforeProvers")(problem);
    const briefing = await hook(M11, "briefing")({ ...problem, claimId } as unknown as SessionContext);
    assert.equal(briefing?.title, "Small models (line M11)");
    const text = briefing?.text ?? "";
    assert.match(text, /^Before any prover started, the statement was tried on 3461 small objects \(battery magmas:3\+4x120@1, by evaluating its laws\): it holds on \d+, fails on \d+\.\n/);
    assert.match(text, /A counter-model: the magma of size 2 with the table \[\[0,0\],\[0,1\]\] \(row a, column b: a \* b\)\.\n/);
    assert.match(text, /A Lean proof of the negation built from it passed the fast check \(validation val_1\), so the statement is false as it is written; the claim is still open until the certifier replays the negation\. Do not spend the session proving it\./);
    assert.match(text, new RegExp(`Candidate, from the fingerprints: this claim is equivalent to claim ${equivalent}, \`${SQUARE_IS_PRODUCT.replace(/[()[\]*]/g, "\\$&")}\`\\. The lemma \`m11_equiv_`));
    assert.match(text, new RegExp(`this claim is implied by claim ${stronger}`));
    assert.match(text, /\nThese are tests on finite objects\. Only a Lean proof settles a claim\.$/);
  });

  it("says that Lean did not accept the negation, and that nothing was submitted", async () => {
    const rejected = await problemOf(LEFT_PROJECTION_COMMUTES, { validate: () => invalid });
    await hook(M11, "beforeProvers")(rejected.problem);
    assert.match(describeFindings(rejected.memory, rejected.claimId) ?? "", /Lean did not accept the proofs of the negation built from it \(unsolved goals\)\. The evaluator and Lean may read the statement differently/);
    const quiet = await problemOf(LEFT_PROJECTION_COMMUTES, { options: { refute: false } });
    await hook(M11, "beforeProvers")(quiet.problem);
    assert.match(describeFindings(quiet.memory, quiet.claimId) ?? "", /No proof of the negation was submitted\./);
  });

  it("stops the provers once a proof of the negation has passed, unless the option says not to", async () => {
    const validations = (list: Array<{ negation: boolean; verdict: "valid" | "invalid"; validationId: string }>) =>
      ({ claimId: "clm_1", options: M11_DEFAULTS, memory: { validations: () => list } }) as unknown as SessionContext;
    const none = validations([]);
    assert.equal(await hook(M11, "beforeSession")(none), undefined);
    const proofOnly = validations([{ negation: false, verdict: "valid", validationId: "val_1" }, { negation: true, verdict: "invalid", validationId: "val_2" }]);
    assert.equal(await hook(M11, "beforeSession")(proofOnly), undefined);
    const refuted = validations([{ negation: true, verdict: "invalid", validationId: "val_2" }, { negation: true, verdict: "valid", validationId: "val_3" }]);
    assert.deepEqual(await hook(M11, "beforeSession")(refuted), { stop: "a Lean proof of the negation passed the fast check (validation val_3); the claim is false as stated" });
    const optional = { ...refuted, options: { ...M11_DEFAULTS, stopWhenRefuted: false } } as unknown as SessionContext;
    assert.equal(await hook(M11, "beforeSession")(optional), undefined);
  });
});

describe("the small_models tool", () => {
  async function toolOf(setup: Setup = {}) {
    const run = await problemOf(setup.statement ?? CONSTANT_IN_Y, setup);
    await hook(M11, "beforeProvers")(run.problem);
    const session = { ...run.problem, prover: "p1", session: 1, sessions: 2, attemptId: "att_1", model: "m/x", regions: { aux: "", proof: "" } } as unknown as SessionContext;
    const [tool, ...rest] = await hook(M11, "tools")(session);
    assert.equal(rest.length, 0);
    assert.ok(tool !== undefined);
    const callWith = (args: Record<string, string | undefined>) => tool.run(args as { [key: string]: string }, new AbortController().signal);
    return { ...run, tool, callWith, call: (statement: unknown) => tool.run({ statement } as { statement: string }, new AbortController().signal) };
  }

  it("is declared with a name, a description and a schema with the statement, the program and the battery", async () => {
    const { tool } = await toolOf();
    assert.equal(tool.name, "small_models");
    assert.match(tool.name, /^[a-z0-9_]+$/);
    assert.match(tool.description, /^Tries a statement, or a program, on small models/);
    assert.deepEqual(Object.keys(tool.parameters.properties as object), ["statement", "program", "battery"]);
    assert.deepEqual((tool.parameters.properties as { battery: { enum: string[] } }).battery.enum, ["magmas", "groups", "graphs", "integers"]);
  });

  it("tests a statement of magmas, shows counter-models, and compares it with the statement being proved", async () => {
    const { call } = await toolOf();
    const stronger = await call(LEFT_PROJECTION);
    assert.match(stronger, /^On magmas:3\+4x120@1 \(3461 objects, by evaluating its laws\) the statement holds on \d+ and fails on \d+\./);
    assert.match(stronger, /Counter-model: the magma of size 2 with the table \[\[0,0\],\[0,0\]\]/);
    assert.equal((stronger.match(/Counter-model:/g) ?? []).length, 3);
    assert.match(stronger, /It implies the statement you are proving on this battery: it looks stronger/);
    assert.match(stronger, /This is a test on finite objects, and no proof\.$/);
    assert.match(await call(SQUARE_IS_PRODUCT), /same verdicts as the statement you are proving: they look equivalent/);
    assert.match(await call("(M : Type) [Mul M] : ∀ x y : M, x * y = y * x"), /Neither it nor the statement you are proving implies the other/);
    assert.match(await call("(M : Type) [Mul M] (h : ∀ x y : M, x * y = x) : ∀ x y z : M, x * y = x * z"), /^On magmas:.* fails on 0\.\nThe battery does not tell how it compares/);
    assert.match(await call("(M : Type) [Mul M] : ∀ x y : M, x * y = x * y ∨ x = y"), /Not tried: /);
  });

  it("tests a statement about a number on the numbers the option gives", async () => {
    const { call } = await toolOf({ lean: new SimulatedDecide({ truth: (i) => (i.kind === "nat" ? i.value < 12 : undefined) }), options: { toolMaxNumber: 20 } });
    const answer = await call("(n : ℕ) : n < 12");
    assert.match(answer, /^On integers:0\.\.20 \(21 objects, by `decide` in Lean\) the statement holds on 12 and fails on 9\.\nCounter-model: the number 12\.\nCounter-model: the number 13\.\nCounter-model: the number 14\./);
    // The problem's own claim is about magmas: the batteries differ, so there is nothing to compare.
    assert.doesNotMatch(answer, /statement you are proving/);
  });

  it("are the same for each call, which has the whole cap for itself", async () => {
    const lean = new SimulatedDecide({ truth: (i) => (i.kind === "nat" ? i.value < 12 : undefined) });
    const { call } = await toolOf({ lean, options: { toolMaxNumber: 100, leanFiles: 5, lawWork: 150_000 } });
    const numbers = await call("(n : ℕ) : n < 12");
    assert.equal(lean.calls.length, 5);
    assert.match(numbers, /with no verdict on \d+\./);
    assert.match(numbers, /The cap of 5 Lean files \(option M11\.leanFiles\) was reached/);
    // The call before it did not use up what the next one has.
    await call("(n : ℕ) : n < 12");
    assert.equal(lean.calls.length, 10);

    // x * y = z * w: 1 + 160 + 269 730 + 30 720 = 300 611 assignments, over 150 000. The problem's own law takes 97 671 each time it is tried:
    // two calls are within the cap because each has the whole of it (together they would not be).
    assert.match(await call("(M : Type) [Mul M] : ∀ x y z w : M, x * y = z * w"), /^Not tried: the law evaluator would try up to 300611 assignments of the variables, over the 150000 that the cap \(option M11\.lawWork\) leaves for it/);
    assert.match(await call(CONSTANT_IN_Y), /^On magmas:3\+4x120@1/);
    assert.match(await call(CONSTANT_IN_Y), /^On magmas:3\+4x120@1/);
  });

  it("explains what it cannot try, and asks for the statement when none is given", async () => {
    const { call } = await toolOf();
    assert.match(await call("(G : Type*) [Group G] (a b : G) : a * b = b * a"), /^Not tried: .*A statement is in signature form: /);
    await assert.rejects(call(""), /give a statement or a program, one of the two\. A statement is in signature form/);
    await assert.rejects(call(undefined), /give a statement or a program, one of the two/);
  });

  it("does not write a statement that holds a forbidden token into a Lean file", async () => {
    const lean = new SimulatedDecide({ truth: () => true });
    const { call } = await toolOf({ lean, statement: EVEN });
    const before = lean.calls.length;
    const answer = await call("(n : ℕ) : n = n\n#eval IO.Process.exit 7\nmacro_rules | `(tactic| rfl) => `(tactic| skip)");
    assert.match(answer, /^Not tried: the statement holds the tokens '#eval', 'macro_rules'/);
    assert.equal(lean.calls.length, before, "Lean was not asked");
  });

  it("tries a program, a JavaScript function, on the numbers, the magmas, the groups or the graphs", async () => {
    const { callWith } = await toolOf();
    const numbers = await callWith({ program: "(n) => n % 3 !== 2" });
    assert.match(numbers, /^On integers:0\.\.100 \(101 objects, by your program\) it returns true on 68 and false on 33\.\nCounter-example: the number 2\.\nCounter-example: the number 5\.\nCounter-example: the number 8\.\nThis is a test on finite objects, and no proof\.$/);
    const graphs = await callWith({ program: "(g) => g.edges.length >= g.n - 1", battery: "graphs" });
    assert.match(graphs, /^On graphs:6 \(208 objects, by your program\) it returns true on \d+ and false on \d+\.\nCounter-example: the graph on 2 vertices with no edge \(graph6 A\?\)\./);
    const magmas = await callWith({ program: "(m) => m.table[0] === 0", battery: "magmas" });
    assert.match(magmas, /^On magmas:3\+4x120@1 \(3461 objects, by your program\) it returns true on \d+ and false on \d+\.\n/);
    const abelian = await callWith({
      program: "function (g) { for (let a = 0; a < g.size; a++) for (let b = 0; b < g.size; b++) if (g.table[a * g.size + b] !== g.table[b * g.size + a]) return false; return true; }",
      battery: "groups",
    });
    assert.match(abelian, /^On groups:12 \(\d+ objects, by your program\) it returns true on \d+ and false on \d+\.\nCounter-example: D3, the magma of size 6/);
  });

  it("says what a program did that has no verdict, or cannot run, and refuses a bad battery", async () => {
    const { callWith } = await toolOf();
    assert.match(await callWith({ program: "(n) => 'yes'" }), /it returns true on 0 and false on 0, and gives no verdict on 101\.\nNo verdict on some objects: not a boolean\./);
    assert.match(await callWith({ program: "(n) => {" }), /gives no verdict on 101\.\nThe run stopped: the program does not compile/);
    await assert.rejects(callWith({ program: "(n) => true", battery: "rings" }), /battery is one of magmas, groups, graphs, integers, not "rings"/);
    await assert.rejects(callWith({ program: "(n) => true", statement: COMMUTATIVE }), /give a statement or a program, one of the two/);
  });
});
