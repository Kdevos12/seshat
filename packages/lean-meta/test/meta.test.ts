import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BlobStore,
  Journal,
  type LeanCheckOptions,
  type LeanCheckResult,
  type LeanChecker,
  type LeanSnippet,
  statementIdV0,
} from "@seshat/core";
import { MemoryStore } from "@seshat/memory";
import { type HostProfile, type ImplementationFactory, loadCatalog, loadHostProfile, Registry, UnavailableError } from "@seshat/registry";
import {
  DEFAULT_HEARTBEATS,
  type LeanMetaInput,
  LeanIdentity,
  LeanMeta,
  LeanMetaError,
  leanMetaFactory,
  leanMetaImplementation,
  metaSnippet,
  SimulatedLeanMeta,
  simulatedId,
  TRUE_ID,
  withSeshatMeta,
} from "../src/index.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const catalog = loadCatalog(join(REPO, "capabilities"));
const ID = `st1_${"0123456789abcdef".repeat(2)}`;

/** A Lean checker that answers each snippet with what `reply` says, and records what it got. */
class ScriptedChecker implements LeanChecker {
  readonly implementation = "scripted-lean";
  readonly version = "0";
  readonly seen: LeanSnippet[] = [];
  readonly options: LeanCheckOptions[] = [];
  private readonly reply: (code: string) => Partial<LeanCheckResult>;

  constructor(reply: (code: string) => Partial<LeanCheckResult>) {
    this.reply = reply;
  }

  async check(snippets: readonly LeanSnippet[], options: LeanCheckOptions = {}): Promise<LeanCheckResult[]> {
    this.seen.push(...snippets);
    this.options.push(options);
    return snippets.map((s) => ({ id: s.id, status: "valid", messages: [], sorries: [], timeMs: 1, ...this.reply(s.code) }));
  }
}

/** The line of the `#seshat_*` command in a snippet. */
function commandLine(code: string): number {
  return code.split("\n").findIndex((l) => l.startsWith("#seshat_")) + 1;
}

/** Lean's information message at the command, as SeshatMeta prints its answer. */
function answering(text: string | ((code: string) => string)): (code: string) => Partial<LeanCheckResult> {
  return (code) => ({ messages: [{ severity: "info", pos: { line: commandLine(code), column: 0 }, text: typeof text === "string" ? text : text(code) }] });
}

function invoke(checker: LeanChecker, input: LeanMetaInput, timeoutMs = 300_000) {
  return leanMetaImplementation(checker).invoke(input as never, { signal: new AbortController().signal, timeoutMs });
}

function registryWith(factory: ImplementationFactory): Registry {
  const host: HostProfile = { host: "test", capabilities: { "lean.meta": { use: ["kimina"] } } };
  return new Registry({ catalog, host, factories: { "kimina-meta": factory } });
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "seshat-lean-meta-"));
}

describe("the snippets of lean.meta", () => {
  it("reads a statement under the default header, with SeshatMeta imported after the imports", () => {
    const snippet = metaSnippet({ op: "hash", statement: "(n : ℕ) : n + 0 = n" });
    assert.equal(snippet.code, "import Mathlib\nimport SeshatMeta\n\n#seshat_hash (n : ℕ) : n + 0 = n\n");
    assert.deepEqual([snippet.firstLine, snippet.lastLine], [4, 4]);
  });

  it("keeps the header's definitions after its imports, and the command's lines right", () => {
    const header = "/- The problem's prefix. -/\nimport Mathlib\nimport FormalConjectures.Util.ProblemImports\n\nnamespace Harness\n\ndef double (n : ℕ) : ℕ := n + n\n\nend Harness\n";
    const snippet = metaSnippet({ op: "hash", statement: "(n : ℕ) :\n  Harness.double n = 2 * n -- by definition", header, simp: ["two_mul", "Harness.double"] });
    const lines = snippet.code.split("\n");
    assert.deepEqual(lines.slice(0, 5), ["", "import Mathlib", "import FormalConjectures.Util.ProblemImports", "import SeshatMeta", ""]);
    assert.equal(lines[7], "def double (n : ℕ) : ℕ := n + n");
    assert.deepEqual(lines.slice(snippet.firstLine - 1, snippet.lastLine), [
      "#seshat_hash (n : ℕ) :",
      "  Harness.double n = 2 * n -- by definition",
      "  using [two_mul, Harness.double]",
    ]);
  });

  it("imports SeshatMeta once, and alone under an empty header", () => {
    assert.equal(withSeshatMeta("import Mathlib\nimport SeshatMeta\n"), "import Mathlib\nimport SeshatMeta\n");
    assert.equal(withSeshatMeta("open Nat"), "import SeshatMeta\nopen Nat");
    assert.equal(metaSnippet({ op: "hash", statement: ": True", header: "" }).code, "import SeshatMeta\n\n#seshat_hash : True\n");
  });

  it("puts defeq under its heartbeat limit, each statement on its own lines", () => {
    const snippet = metaSnippet({ op: "defeq", statement: "(n : ℕ) : n = n -- a comment", other: "(n : ℕ) : n + 0 = n" });
    assert.deepEqual(snippet.code.split("\n").slice(snippet.firstLine - 1, snippet.lastLine), [
      `set_option maxHeartbeats ${DEFAULT_HEARTBEATS} in`,
      "#seshat_defeq (n : ℕ) : n = n -- a comment",
      "  with (n : ℕ) : n + 0 = n",
    ]);
    assert.match(metaSnippet({ op: "defeq", statement: ": True", other: ": True", heartbeats: 5 }).code, /\nset_option maxHeartbeats 5 in\n/);
  });

  it("declares the facts given by statements as axioms, and names the others", () => {
    const snippet = metaSnippet({
      op: "instances",
      statement: ": 2 + 3 = 3 + 2",
      facts: [{ name: "add_comm_nat", statement: "(a b : ℕ) :\n  a + b = b + a" }, { name: "Nat.add_comm" }],
    });
    assert.match(snippet.code, /\nset_option autoImplicit false\n\naxiom seshat_fact_0 \(a b : ℕ\) :\n {2}a \+ b = b \+ a\n/);
    const lines = snippet.code.split("\n");
    assert.equal(lines[snippet.firstLine - 1], "#seshat_instances : 2 + 3 = 3 + 2");
    assert.equal(lines[snippet.lastLine - 1], "  using [seshat_fact_0, Nat.add_comm]");
  });

  it("runs premises after the whole file", () => {
    const snippet = metaSnippet({ op: "premises", code: "import Mathlib\n\ntheorem t : True := trivial\n", declaration: "t" });
    assert.equal(snippet.code, "import Mathlib\nimport SeshatMeta\n\ntheorem t : True := trivial\n\n#seshat_premises t\n");
    assert.deepEqual([snippet.firstLine, snippet.lastLine], [6, 6]);
  });
});

describe("lean.meta over a Lean checker", () => {
  it("reads the command's answer, and nothing else", async () => {
    const checker = new ScriptedChecker((code) => ({
      messages: [
        { severity: "info", pos: { line: 1, column: 0 }, text: `{"id":"st1_${"f".repeat(32)}"}` },
        { severity: "warning", pos: { line: commandLine(code), column: 0 }, text: "unused variable" },
        { severity: "info", pos: { line: commandLine(code), column: 0 }, text: "not an answer" },
        { severity: "info", pos: { line: commandLine(code), column: 0 }, text: ` {"id":"${ID}"}\n` },
      ],
    }));
    assert.deepEqual(await invoke(checker, { op: "hash", statement: "(n : ℕ) : n = n" }), { id: ID });
    assert.equal(checker.seen.length, 1);
  });

  it("fails without an answer on the command's lines, or with two", async () => {
    const outside = new ScriptedChecker(() => ({ messages: [{ severity: "info", pos: { line: 1, column: 0 }, text: `{"id":"${ID}"}` }] }));
    await assert.rejects(invoke(outside, { op: "hash", statement: ": True" }), /SeshatMeta gave no answer/);
    const twice = new ScriptedChecker((code) => ({
      messages: [1, 2].map(() => ({ severity: "info" as const, pos: { line: commandLine(code), column: 0 }, text: `{"id":"${ID}"}` })),
    }));
    await assert.rejects(invoke(twice, { op: "hash", statement: ": True" }), /SeshatMeta gave 2 answers/);
  });

  it("fails with Lean's errors", async () => {
    const checker = new ScriptedChecker((code) => ({
      status: "lean_error",
      messages: [{ severity: "error", pos: { line: commandLine(code), column: 23 }, text: "unknown identifier 'notDefinedAnywhere'" }],
    }));
    await assert.rejects(invoke(checker, { op: "hash", statement: "(n : ℕ) : notDefinedAnywhere n" }), /Lean error at the command: unknown identifier 'notDefinedAnywhere'/);
    const header = new ScriptedChecker(() => ({ messages: [{ severity: "error", pos: { line: 2, column: 0 }, text: "unknown module prefix 'SeshatMeta'" }] }));
    await assert.rejects(invoke(header, { op: "profile", statement: ": True" }), /Lean error at line 2 of the file: unknown module prefix/);
  });

  it("counts a call that never reached Lean as unavailable, and Lean's time limit as a failure", async () => {
    const down = new ScriptedChecker(() => ({ status: "server_error", error: "connection refused" }));
    await assert.rejects(invoke(down, { op: "hash", statement: ": True" }), (e: unknown) => e instanceof UnavailableError && /connection refused/.test(e.message));
    const slow = new ScriptedChecker(() => ({ status: "timeout" }));
    await assert.rejects(invoke(slow, { op: "hash", statement: ": True" }), (e: unknown) => !(e instanceof UnavailableError) && /Lean ran out of time/.test(String(e)));
  });

  it("refuses an answer that is not what the command prints", async () => {
    await assert.rejects(invoke(new ScriptedChecker(answering(`{"id":"st0_${"a".repeat(32)}"}`)), { op: "hash", statement: ": True" }), /another form/);
    await assert.rejects(invoke(new ScriptedChecker(answering(`{"defeq":"yes"}`)), { op: "defeq", statement: ": True", other: ": True" }), /defeq "yes"/);
    await assert.rejects(invoke(new ScriptedChecker(answering(`{"premises":[1]}`)), { op: "premises", code: "x", declaration: "t" }), /premises \[1\]/);
  });

  it("answers each operation, and names the facts by their positions", async () => {
    const facts = [{ name: "a", statement: ": True" }, { name: "b" }];
    const out = (text: string, input: LeanMetaInput) => invoke(new ScriptedChecker(answering(text)), input);
    assert.deepEqual(await out(`{"defeq":null}`, { op: "defeq", statement: ": True", other: ": True" }), { defeq: null });
    assert.deepEqual(await out(`{"premises":["Nat.add_comm"]}`, { op: "premises", code: "x", declaration: "t" }), { premises: ["Nat.add_comm"] });
    assert.deepEqual(await out(`{"classes":["Group"],"instances":[]}`, { op: "profile", statement: ": True" }), { classes: ["Group"], instances: [] });
    assert.deepEqual(await out(`{"instanceOf":[1,1],"covers":[0]}`, { op: "instances", statement: ": True", facts }), { instanceOf: ["b"], covers: ["a"] });
    await assert.rejects(out(`{"instanceOf":[2],"covers":[]}`, { op: "instances", statement: ": True", facts }), /instanceOf \[2\]/);
  });

  it("gives Lean the call's time limit, or the registry's less its margin", async () => {
    const checker = new ScriptedChecker(answering(`{"id":"${ID}"}`));
    await invoke(checker, { op: "hash", statement: ": True", timeoutSec: 30 });
    await invoke(checker, { op: "hash", statement: ": True" }, 90_500);
    await invoke(checker, { op: "hash", statement: ": True" }, 10_000);
    assert.deepEqual(checker.options.map((o) => o.timeoutSec), [30, 75, 1]);
  });

  it("checks its health by asking for the id of True", async () => {
    const good = new ScriptedChecker(answering(`{"id":"${TRUE_ID}"}`));
    const health = await leanMetaImplementation(good).health?.({ signal: new AbortController().signal });
    assert.equal(health?.ok, true);
    assert.equal(good.seen[0]?.code, "import SeshatMeta\n\n#seshat_hash : True\n");
    const other = await leanMetaImplementation(new ScriptedChecker(answering(`{"id":"${ID}"}`))).health?.({ signal: new AbortController().signal });
    assert.equal(other?.ok, false);
    assert.match(other?.detail ?? "", /another canonical form/);
    const missing = await leanMetaImplementation(new ScriptedChecker(() => ({}))).health?.({ signal: new AbortController().signal });
    assert.deepEqual([missing?.ok, /SeshatMeta does not answer/.test(missing?.detail ?? "")], [false, true]);
  });
});

describe("the typed client of lean.meta", () => {
  const replies = (code: string): string => {
    if (code.includes("#seshat_hash")) return `{"id":"${ID}"}`;
    if (code.includes("#seshat_defeq")) return `{"defeq":true}`;
    if (code.includes("#seshat_premises")) return `{"premises":["Nat.add_comm"]}`;
    if (code.includes("#seshat_profile")) return `{"classes":["Group","HMul"],"instances":["instHMul"]}`;
    return `{"instanceOf":[1],"covers":[]}`;
  };

  it("answers every operation through the registry", async () => {
    const checker = new ScriptedChecker(answering(replies));
    const meta = new LeanMeta(registryWith(leanMetaFactory(() => checker)));
    assert.equal(await meta.hash("(n : ℕ) : n = n", { simp: ["ge_iff_le"], timeoutSec: 12.5 }), ID);
    assert.equal(await meta.defEq("(n : ℕ) : n + 0 = n", "(n : ℕ) : n = n", { heartbeats: 1000 }), true);
    assert.deepEqual(await meta.premises("import Mathlib\n\ntheorem t (a b : ℕ) : a + b = b + a := Nat.add_comm a b\n", "t"), ["Nat.add_comm"]);
    assert.deepEqual(await meta.profile("(G : Type) [Group G] (a : G) : a * a⁻¹ = 1"), { classes: ["Group", "HMul"], instances: ["instHMul"] });
    assert.deepEqual(await meta.instances(": 2 + 3 = 3 + 2", [{ name: "mul_one_nat", statement: "(a : ℕ) : a * 1 = a" }, { name: "add_comm" }]), {
      instanceOf: ["add_comm"],
      covers: [],
    });
    assert.match(checker.seen[0]?.code ?? "", /\n {2}using \[ge_iff_le\]\n$/);
    assert.equal(checker.options[0]?.timeoutSec, 13);
    assert.match(checker.seen[1]?.code ?? "", /\nset_option maxHeartbeats 1000 in\n/);
    // Without timeoutSec the registry allows the manifest's 300 s, and Lean gets 15 s less.
    assert.deepEqual(checker.options.slice(1).map((o) => o.timeoutSec), [285, 285, 285, 285]);
  });

  it("says rejected when Lean refuses, and unreachable when no answer came", async () => {
    const refusing = new LeanMeta(registryWith(leanMetaFactory(() => new ScriptedChecker((code) => ({ messages: [{ severity: "error", pos: { line: commandLine(code), column: 0 }, text: "unknown identifier 'x'" }] })))));
    await assert.rejects(refusing.hash("(n : ℕ) : x = n"), (e: unknown) => e instanceof LeanMetaError && e.kind === "rejected" && /unknown identifier 'x'/.test(e.details.join("\n")));
    const down = new LeanMeta(registryWith(leanMetaFactory(() => new ScriptedChecker(() => ({ status: "server_error", error: "connection refused" })))));
    await assert.rejects(down.hash(": True"), (e: unknown) => e instanceof LeanMetaError && e.kind === "unreachable");
    const elsewhere = new LeanMeta(new Registry({ catalog, host: { host: "bare", capabilities: {} } }));
    await assert.rejects(elsewhere.profile(": True"), (e: unknown) => e instanceof LeanMetaError && e.kind === "unreachable" && /not offered/.test(e.message));
  });

  it("refuses a name the schema does not take, before Lean", async () => {
    const checker = new ScriptedChecker(answering(replies));
    const meta = new LeanMeta(registryWith(leanMetaFactory(() => checker)));
    await assert.rejects(meta.instances(": True", [{ name: "two words" }]), (e: unknown) => e instanceof LeanMetaError && e.kind === "rejected");
    await assert.rejects(meta.hash(": True", { simp: ["a, b"] }), (e: unknown) => e instanceof LeanMetaError && e.kind === "rejected");
    assert.equal(checker.seen.length, 0);
  });
});

describe("LeanIdentity", () => {
  const same = simulatedId("(n : ℕ) : n + 0 = n");
  const table = () =>
    new SimulatedLeanMeta([
      { input: { op: "hash", statement: "{m : Nat} : m + 0 = m" }, output: { id: same } },
      { input: { op: "hash", statement: "(n : ℕ) : notDefinedAnywhere n" }, error: "unknown identifier 'notDefinedAnywhere'" },
    ]);

  it("gives st1 ids, the same to statements Lean elaborates to the same term", async () => {
    const simulated = table();
    const identity = new LeanIdentity(new LeanMeta(registryWith(simulated.factory())));
    assert.equal(identity.version, "st1");
    const id = await identity.id("(n : ℕ) : n + 0 = n");
    assert.match(id, /^st1_[0-9a-f]{32}$/);
    assert.equal(await identity.id("{m : Nat} : m + 0 = m"), id);
    assert.notEqual(await identity.id("(n : ℕ) : n = n"), id);
  });

  it("reads a statement under its header, or the identity's default", async () => {
    const simulated = table();
    const identity = new LeanIdentity(new LeanMeta(registryWith(simulated.factory())), { header: "import Mathlib\nopen Nat", timeoutSec: 60 });
    await identity.id(": True");
    await identity.id(": True", { header: "import Mathlib\n\ndef d := 1" });
    assert.deepEqual(
      simulated.calls.map((c) => [c.op === "hash" ? c.header : undefined, c.timeoutSec]),
      [
        ["import Mathlib\nopen Nat", 60],
        ["import Mathlib\n\ndef d := 1", 60],
      ],
    );
  });

  it("asks Lean once per statement and header, and again after a failure", async () => {
    const simulated = table();
    const identity = new LeanIdentity(new LeanMeta(registryWith(simulated.factory())), { cacheSize: 2 });
    const [a, b] = await Promise.all([identity.id(": True"), identity.id(": True")]);
    assert.equal(a, b);
    assert.equal(simulated.calls.length, 1);
    await identity.id(": False");
    await identity.id(": 1 = 1");
    await identity.id(": True");
    assert.equal(simulated.calls.length, 4, "the oldest id was dropped from a cache of two");
    for (let i = 0; i < 2; i++) {
      await assert.rejects(identity.id("(n : ℕ) : notDefinedAnywhere n"), (e: unknown) => e instanceof LeanMetaError && e.kind === "rejected");
    }
    assert.equal(simulated.calls.length, 6);
  });

  it("gives an informal statement its textual id, without Lean", async () => {
    const simulated = table();
    const identity = new LeanIdentity(new LeanMeta(registryWith(simulated.factory())));
    const text = "Every even number greater than 2 is a sum of two primes.";
    assert.equal(await identity.id(text, { kind: "informal" }), statementIdV0(text));
    assert.equal(simulated.calls.length, 0);
  });

  it("makes the memory store find the claim of a statement written another way", async () => {
    const dir = tempDir();
    const journal = Journal.open(dir, "run_meta");
    try {
      const memory = new MemoryStore({ journal, blobs: new BlobStore(join(dir, "blobs")), identity: new LeanIdentity(new LeanMeta(registryWith(table().factory()))) });
      const first = await memory.ensureClaim({ statement: "(n : ℕ) : n + 0 = n", header: "import Mathlib", origin: "test" });
      const again = await memory.ensureClaim({ statement: "{m : Nat} : m + 0 = m", origin: "test" });
      assert.deepEqual([first.created, again.created, again.claimId, again.statementId], [true, false, first.claimId, same]);
      await assert.rejects(memory.ensureClaim({ statement: "(n : ℕ) : notDefinedAnywhere n", origin: "test" }), LeanMetaError);
    } finally {
      journal.close();
    }
  });
});

describe("the capability lean.meta", () => {
  it("loads with its contract, whose inputs fit its schema", () => {
    const capability = catalog.capabilities.get("lean.meta");
    assert.ok(capability);
    assert.equal(capability.manifest.exposure, "auto");
    assert.deepEqual(
      capability.manifest.implementations.map((i) => [i.id, i.kind === "inproc" ? i.factory : ""]),
      [["kimina", "kimina-meta"]],
    );
    const ops = new Set(capability.contract.map((c) => (c.input as { op: string }).op));
    assert.deepEqual([...ops].sort(), ["defeq", "hash", "instances", "premises", "profile"]);
    assert.ok(capability.contract.some((c) => c.fails !== undefined));
  });

  it("is offered with lean.goals by the repository's host profiles", () => {
    const anyFactory: ImplementationFactory = () => ({ invoke: async () => ({}) });
    // Every factory a manifest names, so that a capability added to the profiles later does not break this test.
    const factories: Record<string, ImplementationFactory> = {};
    for (const { manifest } of catalog.capabilities.values()) {
      for (const spec of manifest.implementations) if (spec.kind === "inproc") factories[spec.factory] = anyFactory;
    }
    for (const host of ["local", "server"]) {
      const profile = loadHostProfile(join(REPO, "config", "hosts", `${host}.json`));
      const registry = new Registry({ catalog, host: profile, factories: { ...factories, "kimina-meta": new SimulatedLeanMeta().factory() } });
      assert.deepEqual([registry.offers("lean.meta"), registry.offers("lean.goals")], [true, true], host);
    }
  });

  it("refuses a simulated call its table does not answer", async () => {
    const meta = new LeanMeta(registryWith(new SimulatedLeanMeta([{ input: { op: "profile" }, unavailable: "no server" }]).factory()));
    await assert.rejects(meta.premises("x", "t"), (e: unknown) => e instanceof LeanMetaError && e.kind === "rejected" && /no answer/.test(e.details.join("\n")));
    await assert.rejects(meta.profile(": True"), (e: unknown) => e instanceof LeanMetaError && e.kind === "unreachable");
  });
});
