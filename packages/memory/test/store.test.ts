import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BlobStore, canTransition, CLAIM_STATUSES, type ClaimStatus, Journal, prepareSketch, readEvents, sha256Hex, statementIdV0 } from "@seshat/core";
import { claimSource, claimTheoremName, MemoryStore, negationReference, type StatementIdentity } from "../src/index.ts";

function open(identity?: StatementIdentity): { memory: MemoryStore; journal: Journal; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "mh-memory-"));
  const journal = Journal.open(dir, "run_1");
  const blobs = new BlobStore(join(dir, "blobs"));
  return { memory: new MemoryStore({ journal, blobs, ...(identity !== undefined ? { identity } : {}) }), journal, dir };
}

/**
 * Proves the link lemma of an edge: a claim with the link's statement and a valid validation of it.
 * The validation is the validator's event, written with the journal `open` returns: a store has no
 * way to write one.
 */
async function checkedLink(
  memory: MemoryStore,
  journal: Journal,
  statement: string,
): Promise<{ link: { name: string; statement: string }; validationId: string }> {
  const { claimId } = await memory.ensureClaim({ statement, origin: "test" });
  const validationId = `val_${claimId}`;
  journal.emit(
    "validation.finished",
    { validationId, claimId, method: "repl", verdict: "valid", reasons: [], axioms: [], submissionHash: "h" },
    "validator",
  );
  return { link: { name: `link_${claimId}`, statement }, validationId };
}

describe("MemoryStore claims", () => {
  it("keep one claim per statement id, whatever the spacing and comments", async () => {
    const { memory, journal, dir } = open();
    const first = await memory.ensureClaim({ statement: "(n : ℕ) : n + 0 = n", origin: "test", gloss: "first", domain: ["11"], header: "import Mathlib" });
    assert.equal(first.created, true);
    assert.equal(first.statementId, statementIdV0("(n : ℕ) : n + 0 = n", "import Mathlib"));
    const again = await memory
      .withActor("line:M1")
      .ensureClaim({ statement: "(n : ℕ) :  n + 0 = n -- again", header: "import  Mathlib -- the same", origin: "other", gloss: "second" });
    assert.deepEqual(again, { claimId: first.claimId, statementId: first.statementId, created: false });
    const claim = memory.claim(first.claimId);
    assert.equal(claim?.gloss, "first", "the first claim of a statement keeps its fields");
    assert.deepEqual([claim?.kind, claim?.domain, claim?.header, claim?.status, claim?.parentId], ["formal", ["11"], "import Mathlib", "open", undefined]);
    assert.equal(memory.claimByStatement(first.statementId)?.claimId, first.claimId);
    const other = await memory.withActor("line:M1").ensureClaim({ statement: ": True", origin: "line:M1", parentId: first.claimId, kind: "formal" });
    assert.equal(other.created, true);
    assert.notEqual(other.claimId, first.claimId);
    assert.equal(memory.claim(other.claimId)?.parentId, first.claimId);
    await assert.rejects(memory.ensureClaim({ statement: "  ", origin: "test" }), /the statement is empty/);
    journal.close();
    const actors = readEvents(join(dir, "journal.jsonl")).filter((e) => e.type === "claim.created").map((e) => e.actor);
    assert.deepEqual(actors, ["memory", "line:M1"]);
  });

  it("read the header with the default identity: the same text under another header is another claim", async () => {
    const { memory, journal } = open();
    const text = ": 1 + 1 = 2";
    const bare = await memory.ensureClaim({ statement: text, origin: "test" });
    const mathlib = await memory.ensureClaim({ statement: text, header: "import Mathlib", origin: "test" });
    const nat = await memory.ensureClaim({ statement: text, header: "import Mathlib\nopen Nat", origin: "test" });
    assert.equal(bare.statementId, statementIdV0(text), "with no header the id is the text's alone");
    assert.deepEqual([bare.created, mathlib.created, nat.created], [true, true, true]);
    assert.equal(new Set([bare.claimId, mathlib.claimId, nat.claimId]).size, 3);
    assert.equal(memory.claim(nat.claimId)?.header, "import Mathlib\nopen Nat");
    // The header is normalized as the statement is: the same header, spaced and commented, is the same claim.
    const spaced = await memory.ensureClaim({ statement: ":  1 + 1 = 2", header: "import   Mathlib /- as before -/\n", origin: "test" });
    assert.deepEqual(spaced, { claimId: mathlib.claimId, statementId: mathlib.statementId, created: false });
    assert.equal(memory.claim(spaced.claimId)?.header, "import Mathlib", "the first claim's header stands");
    // A header with nothing in it is no header.
    const blank = await memory.ensureClaim({ statement: text, header: "  -- nothing\n", origin: "test" });
    assert.deepEqual(blank, { claimId: bare.claimId, statementId: bare.statementId, created: false });
    journal.close();
  });

  it("accept another identity, asynchronous, and create a claim once under concurrent calls", async () => {
    const identity: StatementIdentity = {
      version: "st9",
      async id(statement, context) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return `st9_${sha256Hex(`${context?.header ?? ""}\n${statement.replace(/\s+/g, "")}`).slice(0, 8)}`;
      },
    };
    const { memory, journal } = open(identity);
    const input = { statement: ": 1 + 1 = 2", origin: "test", header: "import Mathlib" };
    const results = await Promise.all([memory.ensureClaim(input), memory.ensureClaim(input), memory.ensureClaim({ ...input, statement: ":1+1=2" })]);
    assert.match(results[0]?.statementId ?? "", /^st9_[0-9a-f]{8}$/);
    assert.equal(new Set(results.map((r) => r.claimId)).size, 1);
    assert.deepEqual(results.map((r) => r.created), [true, false, false]);
    const elsewhere = await memory.ensureClaim({ ...input, header: "import Other" });
    assert.equal(elsewhere.created, true, "this identity reads the header");
    journal.close();
  });
});

describe("MemoryStore statement form", () => {
  it("accept the signature form: binders of every kind, then a colon and the type", async () => {
    const { memory, journal } = open();
    const forms = [
      ": 1 + 1 = 2",
      "(n : ℕ) : n + 0 = n",
      "{α : Type*} [Fintype α] (s : Finset α) : s.card ≤ Fintype.card α",
      "⦃x : ℕ⦄ (h : x ∈ S := by simp) : x ∈ S",
      "x y : ℕ",
      ".{u} (α : Type u) : Nonempty α → True",
      "«odd name» : True",
      "(n : ℕ) : let m := n; m = n",
      "(n : ℕ) : -- the claim\n  n + 1 = 1 + n",
      ": answer(False) ↔ (A + B).HasPosDensity",
    ];
    for (const statement of forms) {
      const { created } = await memory.ensureClaim({ statement, origin: "test" });
      assert.equal(created, true, statement);
    }
    // Prose is for an informal claim, which has no form to check.
    const prose = await memory.ensureClaim({ statement: "every even number is a sum of two primes", kind: "informal", origin: "test" });
    assert.equal(prose.created, true);
    journal.close();
  });

  it("accept the statements of a real problem file, as the sketch reads them", async () => {
    const { memory, journal } = open();
    const source = readFileSync(new URL("../../core/test/fixtures/erdos-125.lean", import.meta.url), "utf8");
    const names = [...source.matchAll(/^theorem (\S+)/gm)].map((match) => match[1] as string);
    assert.ok(names.length >= 5, "the fixture has its theorems");
    for (const name of names) {
      const { statement } = prepareSketch(source, name);
      assert.equal((await memory.ensureClaim({ statement, origin: "bench:test" })).created, true, `${name}: ${statement}`);
    }
    journal.close();
  });

  it("refuse a bare proposition, a whole declaration or a proof, saying what to write, and create no claim", async () => {
    const { memory, journal } = open();
    const refused: Array<[string, RegExp]> = [
      ["1 + 1 = 2", /'1' is not a binder: write ':' before a statement that has none/],
      ["n + 0 = n", /'\+' is not a binder/],
      ["∀ n : ℕ, n + 0 = n", /'∀' is not a binder/],
      ["Nat.Prime 7", /'7' is not a binder/],
      ["(a + b) * c = a * c + b * c", /'\*' is not a binder/],
      ["True", /there is no ':' before the type/],
      ["Even n", /there is no ':' before the type/],
      ["(n : ℕ", /the '\(' is not closed/],
      ["(n : ℕ) :", /there is nothing after the ':'/],
      ["theorem t : True", /it starts with 'theorem'/],
      ["(n : ℕ) : n = n := rfl", /it contains ':=' and a proof/],
      [": True := by trivial", /it contains ':=' and a proof/],
      ["-- only a comment", /the statement is empty/],
    ];
    for (const [statement, reason] of refused) {
      await assert.rejects(
        memory.ensureClaim({ statement, origin: "test" }),
        (error: Error) =>
          reason.test(error.message) &&
          error.message.startsWith("ensureClaim: the statement is not in signature form") &&
          error.message.includes('"(n : ℕ) : n + 0 = n" or ": 1 + 1 = 2"') &&
          error.message.includes("Got: "),
        statement,
      );
    }
    assert.equal(journal.projection.runSummary().problems, 0);
    assert.equal(journal.log.length, 0, "a refused statement writes nothing");
    journal.close();
  });
});

describe("MemoryStore trust", () => {
  it("keep the journal out of reach, in the store and in the view a line gets", () => {
    const { memory, journal } = open();
    const view = memory.withActor("line:M1");
    for (const store of [memory, view, view.withActor("line:M2")]) {
      assert.equal("journal" in store, false, "no property called journal");
      for (const key of Reflect.ownKeys(store)) {
        assert.notEqual(Reflect.get(store, key), journal, `${String(key)} holds the journal`);
        assert.notEqual(Reflect.get(store, key), journal.log, `${String(key)} holds the log`);
        assert.notEqual(Reflect.get(store, key), journal.projection, `${String(key)} holds the projection`);
      }
    }
    journal.close();
  });
});

describe("MemoryStore edges and nodes", () => {
  it("follow only lean_checked equiv edges to equivalents, both ways", async () => {
    const { memory, journal } = open();
    const ids: Record<string, string> = {};
    for (const name of ["a", "b", "c", "d", "e"]) ids[name] = (await memory.ensureClaim({ statement: `: P_${name}`, origin: "test" })).claimId;
    const { a, b, c, d, e } = ids as Record<"a" | "b" | "c" | "d" | "e", string>;
    const ab = await checkedLink(memory, journal, ": P_a ↔ P_b");
    memory.addEdge({ kind: "equiv", from: a, to: b, status: "lean_checked", ...ab });
    const cb = await checkedLink(memory, journal, ": P_c ↔ P_b");
    const edge = memory.addEdge({ kind: "equiv", from: c, to: [b], link: cb.link });
    assert.deepEqual(memory.equivalents(a), [a, b], "a proposed edge does not count");
    memory.setEdgeStatus(edge.edgeId, "lean_checked", { reason: "link lemma checked", validationId: cb.validationId });
    memory.withActor("human:test").addEdge({ kind: "equiv", from: a, to: d, status: "human_signed" });
    const ae = await checkedLink(memory, journal, ": P_a → P_e");
    memory.addEdge({ kind: "implies", from: a, to: e, status: "lean_checked", ...ae });
    assert.deepEqual(memory.equivalents(a), [a, b, c]);
    assert.deepEqual(memory.equivalents(c), [c, b, a]);
    assert.deepEqual(memory.equivalents(d), [d]);

    const start = (attemptId: string, claimId: string) =>
      journal.emit("attempt.started", { attemptId, claimId, prover: "p0", iteration: 0, model: "PROVIDER/ID", strategy: "simp" }, "prover:p0");
    start("att_c", c);
    start("att_a", a);
    start("att_d", d);
    assert.deepEqual(memory.attempts(a).map((x) => x.attemptId), ["att_a"]);
    assert.deepEqual(memory.attempts(a, { includeEquivalents: true }).map((x) => x.attemptId), ["att_c", "att_a"]);
    assert.deepEqual(
      [memory.attempts(a)[0]?.role, memory.attempts(a)[0]?.declaredStrategy, memory.attempts(a)[0]?.outcome],
      ["prove", "simp", undefined],
    );
    journal.close();
  });

  it("refuse to make an edge lean_checked without a valid validation of its link lemma", async () => {
    const { memory, journal } = open();
    const a = (await memory.ensureClaim({ statement: ": A", origin: "test" })).claimId;
    const b = (await memory.ensureClaim({ statement: ": B", origin: "test" })).claimId;
    const edge = memory.addEdge({ kind: "implies", from: a, to: b, link: { name: "a_b", statement: ": A → B" }, note: "by analogy" });
    assert.throws(() => memory.setEdgeStatus(edge.edgeId, "lean_checked", { reason: "trust me" }), /only with a valid validation of its link lemma/);
    assert.equal(memory.edge(edge.edgeId)?.status, "proposed");
    assert.throws(() => memory.setEdgeStatus("edg_x", "computed", { reason: "x" }), /unknown edge edg_x/);
    journal.close();
  });

  it("select edges by end, kind and least status", async () => {
    const { memory, journal } = open();
    const a = (await memory.ensureClaim({ statement: ": A", origin: "test" })).claimId;
    const b = (await memory.ensureClaim({ statement: ": B", origin: "test" })).claimId;
    const c = (await memory.ensureClaim({ statement: ": C", origin: "test" })).claimId;
    const parts = memory.addEdge({ kind: "decomposes_into", from: a, to: [b, c] });
    const uses = memory.addEdge({ kind: "uses", from: b, to: c, status: "computed" });
    const signed = memory.withActor("human:test").addEdge({ kind: "special_case_of", from: c, to: a, status: "human_signed" });
    assert.deepEqual(parts.to, [b, c]);
    assert.deepEqual(memory.edges({ to: c }).map((x) => x.edgeId), [parts.edgeId, uses.edgeId]);
    assert.deepEqual(memory.edges({ minStatus: "computed" }).map((x) => x.edgeId), [uses.edgeId, signed.edgeId]);
    assert.deepEqual(memory.edges({ minStatus: "lean_checked" }), []);
    assert.deepEqual(memory.edges({ from: c, kinds: ["special_case_of", "implies"] }).map((x) => x.edgeId), [signed.edgeId]);
    assert.equal(memory.edges().length, 3);
    journal.close();
  });

  it("apply a node's patches in order", async () => {
    const { memory, journal } = open();
    const a = (await memory.ensureClaim({ statement: ": A", origin: "test" })).claimId;
    const node = memory.recordNode({ kind: "lesson", claimId: a, data: { text: "try induction", uses: 0, tags: ["nat"] } });
    memory.updateNode(node.nodeId, { uses: 1, tags: null }, "used");
    memory.updateNode(node.nodeId, { uses: 2, where: { file: "X.lean" } }, "used again");
    const updated = memory.updateNode(node.nodeId, { where: { line: 3 } }, "located");
    assert.deepEqual(updated.data, { text: "try induction", uses: 2, where: { file: "X.lean", line: 3 } });
    assert.deepEqual(memory.node(node.nodeId)?.data, updated.data);
    const other = memory.recordNode({ kind: "lesson", data: null });
    assert.equal(other.data, null);
    assert.equal(other.claimId, undefined);
    assert.deepEqual(memory.nodes("lesson").map((n) => n.nodeId), [node.nodeId, other.nodeId]);
    assert.deepEqual(memory.nodes("lesson", { claimId: a }).map((n) => n.nodeId), [node.nodeId]);
    assert.deepEqual(memory.nodes("fingerprint"), []);
    assert.throws(() => memory.recordNode({ kind: "Lesson", data: {} }), /bad kind/);
    journal.close();
  });
});

describe("MemoryStore references", () => {
  it("write a claim's file from its header and statement, and the file of its negation", async () => {
    const { memory, journal } = open();
    const { claimId } = await memory.ensureClaim({ statement: "(n : ℕ) : n + 0 = n", header: "import Mathlib\nopen Nat\n", origin: "test" });
    const name = claimTheoremName(claimId);
    const reference = memory.referenceFor(claimId);
    assert.deepEqual(reference, { source: "import Mathlib\nopen Nat\n\ntheorem " + name + " (n : ℕ) : n + 0 = n := by\n  sorry\n", theorem: name });
    const negation = memory.referenceFor(claimId, { negation: true });
    assert.equal(negation.theorem, `${name}_negation`);
    assert.equal(negation.source, `${reference.source}\ntheorem ${name}_negation : ¬ (type_of% @${name}) := by\n  sorry\n`);
    const bare = await memory.ensureClaim({ statement: ": 1 + 1 = 2", origin: "test" });
    assert.equal(memory.referenceFor(bare.claimId).source, `theorem ${claimTheoremName(bare.claimId)} : 1 + 1 = 2 := by\n  sorry\n`);
    const prose = await memory.ensureClaim({ statement: "every even number is a sum of two primes", kind: "informal", origin: "test" });
    assert.throws(() => memory.referenceFor(prose.claimId), /is informal: it has no Lean reference/);
    assert.throws(() => memory.referenceFor("clm_x"), /unknown claim clm_x/);
    journal.close();
  });

  it("use the file a claim was given, and state its negation after it", async () => {
    const { memory, journal } = open();
    const { claimId } = await memory.ensureClaim({ statement: ": 1 = 1", origin: "bench:x" });
    const source = "import Mathlib\n\nnamespace Erdos1\n\n/-- doc -/\ntheorem erdos_1 : 1 = 1 := by\n  sorry\n\nend Erdos1\n";
    memory.setReference(claimId, { source, theorem: "Erdos1.erdos_1" });
    assert.deepEqual(memory.referenceFor(claimId), { source, theorem: "Erdos1.erdos_1" });
    // The views of the root store read it.
    assert.deepEqual(memory.withActor("line:M1").referenceFor(claimId), { source, theorem: "Erdos1.erdos_1" });
    const negation = memory.referenceFor(claimId, { negation: true });
    assert.equal(negation.theorem, "erdos_1_negation");
    assert.ok(negation.source.startsWith(source.trimEnd()));
    assert.ok(negation.source.endsWith("\n\ntheorem erdos_1_negation : ¬ (type_of% @Erdos1.erdos_1) := by\n  sorry\n"));
    // A file that ends inside its namespace: the negation is stated there.
    const open_ = negationReference({ source: "namespace A\ntheorem «odd name» : True := trivial\n", theorem: "A.«odd name»" });
    assert.equal(open_.theorem, "A.«odd name_negation»");
    assert.throws(() => memory.setReference("clm_x", { source, theorem: "x" }), /unknown claim clm_x/);
    journal.close();
  });

  it("let only the root store set a reference: a line's view cannot replace the file a proof is compared with", async () => {
    const { memory, journal } = open();
    const { claimId } = await memory.ensureClaim({ statement: "(n : ℕ) : n + 0 = n", header: "import Mathlib\n", origin: "test" });
    const own = memory.referenceFor(claimId);
    const view = memory.withActor("line:M1");
    const forged = { source: "theorem anything : True := trivial\n", theorem: "anything" };
    assert.throws(() => view.setReference(claimId, forged), /is a view; only the orchestrator's root store sets a reference file/);
    // A view of a view is a view too, and nothing changed for the root store or for the view.
    assert.throws(() => view.withActor("line:M2").setReference(claimId, forged), /is a view/);
    assert.deepEqual(memory.referenceFor(claimId), own);
    assert.deepEqual(view.referenceFor(claimId), own);
    // The file of a claim that was never given one is rebuilt from the journaled statement and header.
    assert.equal(view.referenceFor(claimId).source, claimSource("import Mathlib\n", claimTheoremName(claimId), "(n : ℕ) : n + 0 = n"));
    journal.close();
  });

  it("give out copies of a reference: a line that changes one changes nothing", async () => {
    const { memory, journal } = open();
    const { claimId } = await memory.ensureClaim({ statement: ": 1 = 1", origin: "bench:x" });
    const given = { source: "theorem a : 1 = 1 := by\n  sorry\n", theorem: "a" };
    memory.setReference(claimId, given);
    given.source = "theorem a : True := trivial\n";
    const view = memory.withActor("line:M1");
    view.referenceFor(claimId).source = "theorem a : True := trivial\n";
    assert.deepEqual(view.referenceFor(claimId), { source: "theorem a : 1 = 1 := by\n  sorry\n", theorem: "a" });
    assert.deepEqual(memory.referenceFor(claimId), view.referenceFor(claimId));
    journal.close();
  });

  it("write a statement after the header, separated by a blank line", () => {
    assert.equal(claimSource("", "t", ": True"), "theorem t : True := by\n  sorry\n");
    assert.equal(claimSource("import Mathlib\n\n\n", "t", "  (x : ℕ) : x = x "), "import Mathlib\n\ntheorem t (x : ℕ) : x = x := by\n  sorry\n");
    assert.equal(claimTheoremName("clm_01ABC"), "clm_01ABC");
    assert.equal(claimTheoremName("9-x.y"), "c_9_x_y");
  });

  it("retract a claim: a candidate goes back to open, a proof or refutation becomes retracted, never higher", async () => {
    const { memory, journal } = open();
    const writer = memory.withActor("line:M2");
    const { claimId } = await memory.ensureClaim({ statement: ": 1 = 1", origin: "test" });
    assert.equal(writer.retractClaim(claimId, { reason: "nothing to withdraw" }).status, "open");
    const validate = (id: string, method: "repl" | "kernel_replay", negation = false) => {
      const validationId = `val_${id}`;
      journal.emit(
        "validation.finished",
        { validationId, claimId, method, verdict: "valid", reasons: [], axioms: [], submissionHash: "h", ...(negation ? { negation: true } : {}) },
        "validator",
      );
      return validationId;
    };
    const candidate = validate("repl", "repl");
    journal.emit("claim.status_changed", { claimId, from: "open", to: "computed", reason: "fast check", validationId: candidate }, "orchestrator");
    const back = writer.retractClaim(claimId, { reason: "a premise was retracted" });
    assert.equal(back.status, "open");
    const certified = validate("kernel", "kernel_replay");
    journal.emit("claim.status_changed", { claimId, from: "open", to: "proved", reason: "certified", validationId: certified }, "orchestrator");
    assert.equal(writer.retractClaim(claimId, { reason: "a premise was retracted" }).status, "retracted");
    assert.equal(writer.retractClaim(claimId, { reason: "again" }).status, "retracted", "a retracted claim stays retracted");
    assert.throws(() => writer.retractClaim("clm_x", { reason: "?" }), /unknown claim clm_x/);
    const changes = readEvents(journal.log.path).filter((e) => e.type === "claim.status_changed");
    assert.deepEqual(
      changes.map((e) => [e.actor, (e.data as { to: string }).to]),
      [["orchestrator", "computed"], ["line:M2", "open"], ["orchestrator", "proved"], ["line:M2", "retracted"]],
    );
    journal.close();
  });

  it("retract a claim never raises it: from every status it does nothing or takes a revocation transition, with its reason and actor", async () => {
    const { memory, journal } = open();
    const writer = memory.withActor("line:M2");
    // What a status trusts, lowest first: a retraction may only move a claim down this list.
    const trust: Record<ClaimStatus, number> = { retracted: 0, open: 1, computed: 2, proved_informal: 3, proved: 4, refuted: 4 };
    // The revocation transitions of the status table, and nothing else: `retracted` stays, it is not reopened.
    const revoked: Record<ClaimStatus, ClaimStatus> = {
      open: "open",
      computed: "open",
      proved_informal: "retracted",
      proved: "retracted",
      refuted: "retracted",
      retracted: "retracted",
    };
    let n = 0;
    /** A claim in a status, reached by the checked changes the journal allows. */
    const claimIn = async (status: ClaimStatus): Promise<string> => {
      n += 1;
      const { claimId } = await memory.ensureClaim({ statement: `: ${n} = ${n}`, origin: "test" });
      const validation = (method: "repl" | "kernel_replay", negation = false): string => {
        const validationId = `val_${n}_${method}${negation ? "_negation" : ""}`;
        journal.emit(
          "validation.finished",
          { validationId, claimId, method, verdict: "valid", reasons: [], axioms: [], submissionHash: "h", ...(negation ? { negation: true } : {}) },
          "validator",
        );
        return validationId;
      };
      const change = (from: ClaimStatus, to: ClaimStatus, validationId?: string): void => {
        journal.emit("claim.status_changed", { claimId, from, to, reason: "setup", ...(validationId !== undefined ? { validationId } : {}) }, "orchestrator");
      };
      if (status === "computed") change("open", "computed", validation("repl"));
      if (status === "proved") change("open", "proved", validation("kernel_replay"));
      if (status === "refuted") change("open", "refuted", validation("kernel_replay", true));
      if (status === "proved_informal" || status === "retracted") change("open", "proved_informal");
      if (status === "retracted") change("proved_informal", "retracted");
      assert.equal(memory.claim(claimId)?.status, status);
      return claimId;
    };

    for (const status of CLAIM_STATUSES) {
      const claimId = await claimIn(status);
      const before = readEvents(journal.log.path).length;
      const after = writer.retractClaim(claimId, { reason: `revoke ${status}` }).status;
      assert.equal(after, revoked[status], `from ${status}`);
      assert.ok(trust[after] <= trust[status], `${status} -> ${after} would raise the claim`);
      const written = readEvents(journal.log.path).slice(before);
      if (after === status) {
        assert.deepEqual(written, [], `from ${status}: nothing is written`);
        continue;
      }
      const [event] = written;
      assert.equal(written.length, 1);
      assert.ok(event?.type === "claim.status_changed");
      assert.deepEqual(
        [event.actor, event.data.from, event.data.to, event.data.reason, canTransition(status, after)],
        ["line:M2", status, after, `revoke ${status}`, true],
      );
    }

    // A reason is required: without one the claim keeps its status and nothing is written.
    const proved = await claimIn("proved");
    const before = readEvents(journal.log.path).length;
    assert.throws(() => writer.retractClaim(proved, { reason: "  " }), /only with a reason/);
    assert.equal(memory.claim(proved)?.status, "proved");
    assert.equal(readEvents(journal.log.path).length, before);
    journal.close();
  });
});
