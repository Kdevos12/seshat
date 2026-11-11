import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { LeanChecker } from "@seshat/core";
import { litFactory } from "@seshat/lit";
import { leanCheckImplementation, loadCatalog, Registry, type HostProfile } from "@seshat/registry";
import { type FakeLit, startFakeLit } from "../../lit/test/fake-lit.ts";
import { hostAt } from "../../lit/test/helpers.ts";
import { fileStatement, intakeCapUsd, REPO_ROOT, solve, type SolveOptions } from "../src/index.ts";
import { fakeSage } from "./fixtures/fake-sage.ts";
import { check, DemoLean, fauxModels, ofType, say, sageRegistry, tempDir } from "./m0-helpers.ts";
import { readEvents } from "@seshat/core";

/** `harness solve --tool`, `--auto-tool`, `--intake`, `--lit` and `--private` at the level of `solve()` (Task 36, CA16, CA17, CA21). */
const catalog = loadCatalog(join(REPO_ROOT, "capabilities"));
const STATEMENT = "theorem collatz_demo (n : ℕ) : n + 0 = n";

function litRegistry(site: { url: string }, lean: LeanChecker): SolveOptions["registry"] {
  const host: HostProfile = { host: "test", capabilities: { "lean.check": { use: ["kimina"] }, "lit.search": hostAt(site.url).capabilities["lit.search"] as never } };
  return (journal, blobs) => new Registry({ catalog, host, factories: { kimina: () => leanCheckImplementation(lean), lit: litFactory() }, journal, blobs });
}

function base(over: Partial<SolveOptions>, responses: Parameters<ReturnType<typeof fauxModels>["faux"]["setResponses"]>[0]) {
  const { models, faux, name } = fauxModels();
  faux.setResponses(responses);
  const lean = new DemoLean();
  const signatures: Array<{ testLemmas?: unknown; notes: string[] }> = [];
  const shown: string[] = [];
  const o: SolveOptions = {
    statement: STATEMENT,
    dir: join(tempDir("mh-solve-intake-"), "run"),
    models,
    model: name,
    maxUsd: 2,
    user: "alice",
    registry: sageRegistry(fakeSage())(lean),
    checker: lean,
    confirm: async (s) => {
      signatures.push(s);
      return true;
    },
    show: (line) => shown.push(line),
    log: (line) => shown.push(line),
    ...over,
  };
  return { o, lean, signatures, shown, faux };
}

const eventsOf = (dir: string) => readEvents(join(dir, "journal.jsonl"));
const autoToolOf = (dir: string) => (ofType(eventsOf(dir), "run.started")[0]?.data.config as { autoTool?: { capability: string } }).autoTool?.capability;
const toolsOf = (dir: string) => (ofType(eventsOf(dir), "run.started")[0]?.data.config as { tools: Array<{ capability: string }> }).tools.map((t) => t.capability);

describe("the kinds the router files a statement under", () => {
  it("are finite, graph, number, or none", () => {
    assert.equal(fileStatement("(x : Fin 5) : x + 0 = x"), "finite");
    assert.equal(fileStatement("(G : SimpleGraph (Fin 5)) (h : G.Adj 0 1) : G.Adj 1 0"), "graph");
    assert.equal(fileStatement("(n : ℕ) (h : 0 < n) : n ≤ n * n"), "number");
    assert.equal(fileStatement("(n : ℕ) : n + 0 = n"), "number");
    assert.equal(fileStatement("(G : Type) [Group G] (a : G) : a * 1 = a"), undefined);
    assert.equal(fileStatement("this is not a statement"), undefined);
  });
});

describe("harness solve --tool and --auto-tool", () => {
  it("gives the provers the named capabilities, and nothing by default", async () => {
    const plain = base({}, [check("exact trivial_proof")]);
    await solve(plain.o);
    assert.deepEqual(toolsOf(plain.o.dir), []);
    const named = base({ tools: ["compute.sage"] }, [check("exact trivial_proof")]);
    await solve(named.o);
    assert.deepEqual(toolsOf(named.o.dir), ["compute.sage"]);
  });

  it("adds the host's compute tool when the statement is filed as finite, graph or number, and says so; not for another statement", async () => {
    const number = base({ autoTool: "compute.sage", statement: "(n : ℕ) : n + 0 = n" }, [check("exact trivial_proof")]);
    await solve(number.o);
    assert.deepEqual(toolsOf(number.o.dir), [], "the tool is the problem's, not the run's");
    assert.equal(autoToolOf(number.o.dir), "compute.sage");
    assert.ok(number.shown.some((l) => /filed as number: the provers get compute\.sage/.test(l)));
    const other = base({ autoTool: "compute.sage", statement: "(G : Type) [Group G] (a : G) : a * 1 = a" }, [check("exact trivial_proof")]);
    await solve(other.o);
    assert.deepEqual(toolsOf(other.o.dir), []);
    assert.ok(!other.shown.some((l) => /the provers get/.test(l)), "a statement that is not filed gets nothing");
    const explicit = base({ autoTool: "compute.sage", tools: ["compute.sage"], statement: "(n : ℕ) : n + 0 = n" }, [check("exact trivial_proof")]);
    await solve(explicit.o);
    assert.deepEqual(toolsOf(explicit.o.dir), ["compute.sage"], "a tool named and filed is given once");
  });
});

describe("the intake of a solve is proportionate and does not repeat", () => {
  const decides = (lean: DemoLean) => lean.calls.filter((c) => /\bdecide\b/.test(c.code)).length;

  it("runs the test lemmas once: the intake reuses the ones solve ran for the signature", async () => {
    const once = base({ intake: { hygiene: true } }, [check("exact trivial_proof")]);
    await solve(once.o);
    const withIntake = decides(once.lean);
    const bare = base({}, [check("exact trivial_proof")]);
    await solve(bare.o);
    assert.ok(withIntake > 0, "the test lemmas ran");
    assert.equal(withIntake, decides(bare.lean), "the intake adds no second run of the test lemmas");
  });

  it("caps the judge call at the smaller of the default and 5% of the allowance, and --intake-usd wins", () => {
    assert.equal(intakeCapUsd({}, 2), 0.05);
    assert.equal(intakeCapUsd({ capShare: 0.05 }, 2), 0.05);
    assert.equal(intakeCapUsd({ capShare: 0.05 }, 0.5), 0.025);
    assert.equal(intakeCapUsd({ capShare: 0.05 }, 100), 0.05);
    assert.equal(intakeCapUsd({ capUsd: 0.2, capShare: 0.05 }, 0.5), 0.2);
  });

  it("solve gives the intake the 5% share of the allowance it has left", async () => {
    const small = base({ maxUsd: 0.4, intake: { hygiene: true } }, [check("exact trivial_proof")]);
    await solve(small.o);
    const started = ofType(eventsOf(small.o.dir), "run.started")[0]?.data.config as { intake: { capShare?: number } };
    assert.equal(started.intake.capShare, 0.05);
  });
});

describe("harness solve with the intake step", () => {
  let site: FakeLit;
  before(async () => {
    site = await startFakeLit();
  });
  after(async () => {
    await site.close();
  });

  const judged = say(JSON.stringify({ results: [0, 1, 2, 3].map((index) => ({ index, verdict: "restricts", quote: "We prove that the conjecture is false: a counterexample exists" })) }));

  it("asks once whether the statement may go to third parties, and journals the answer as the person's", async () => {
    let asked = 0;
    const yes = base({ intake: { literature: true, hygiene: true }, askConsent: async () => (asked++, true) }, [judged, check("exact trivial_proof")]);
    yes.o.registry = litRegistry(site, yes.lean);
    await solve(yes.o);
    assert.equal(asked, 1);
    const events = eventsOf(yes.o.dir);
    const consent = ofType(events, "intake.consented")[0];
    assert.deepEqual([consent?.data.allowed, consent?.data.via, consent?.actor], [true, "asked", "human:alice"]);
    assert.equal(ofType(events, "intake.finished")[0]?.data.kept, 4);
    // The test lemmas are made for a Lean statement too, and shown before the signature.
    assert.notEqual(yes.signatures[0]?.testLemmas, undefined);

    const requests = site.requests.length;
    const no = base({ intake: { literature: true, hygiene: true }, askConsent: async () => false }, [check("exact trivial_proof")]);
    no.o.registry = litRegistry(site, no.lean);
    await solve(no.o);
    assert.equal(site.requests.length, requests, "a no sends nothing");
    assert.deepEqual(ofType(eventsOf(no.o.dir), "intake.consented").map((e) => [e.data.allowed, e.data.via]), [[false, "asked"]]);
    assert.match(ofType(eventsOf(no.o.dir), "intake.finished")[0]?.data.reason ?? "", /^not agreed/);
  });

  it("takes --lit as the person's agreement in a call that cannot ask, and no answer as no", async () => {
    const flagged = base({ intake: { literature: true, hygiene: true, consent: { allowed: true, via: "flag" } } }, [judged, check("exact trivial_proof")]);
    flagged.o.registry = litRegistry(site, flagged.lean);
    await solve(flagged.o);
    const consent = ofType(eventsOf(flagged.o.dir), "intake.consented")[0];
    assert.deepEqual([consent?.data.allowed, consent?.data.via, consent?.actor], [true, "flag", "human:alice"]);
    const requests = site.requests.length;
    const silent = base({ intake: { literature: true, hygiene: true } }, [check("exact trivial_proof")]);
    silent.o.registry = litRegistry(site, silent.lean);
    await solve(silent.o);
    assert.equal(site.requests.length, requests);
    assert.deepEqual(ofType(eventsOf(silent.o.dir), "intake.consented").map((e) => [e.data.allowed, e.data.via]), [[false, "default"]]);
  });

  it("sends nothing with --private, wins over --lit, and never asks", async () => {
    const requests = site.requests.length;
    let asked = 0;
    const priv = base({ private: true, intake: { literature: true, hygiene: true, consent: { allowed: true, via: "flag" } }, askConsent: async () => (asked++, true) }, [check("exact trivial_proof")]);
    priv.o.registry = litRegistry(site, priv.lean);
    await solve(priv.o);
    assert.equal(asked, 0);
    assert.equal(site.requests.length, requests);
    assert.deepEqual(ofType(eventsOf(priv.o.dir), "intake.consented").map((e) => [e.data.allowed, e.data.via]), [[false, "private"]]);
    assert.equal((ofType(eventsOf(priv.o.dir), "run.started")[0]?.data.config as { private?: boolean }).private, true);
  });

  it("leaves solve as it was without the option: no consent, no step, no test lemmas for a Lean statement", async () => {
    const plain = base({}, [check("exact trivial_proof")]);
    await solve(plain.o);
    assert.equal(ofType(eventsOf(plain.o.dir), "intake.finished").length + ofType(eventsOf(plain.o.dir), "intake.consented").length, 0);
    assert.equal(plain.signatures[0]?.testLemmas, undefined);
  });
});
