import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type LeanCheckOptions, type LeanCheckResult, type LeanChecker, type LeanSnippet, readEvents } from "@seshat/core";
import { leanSearchFactory, type Fetch } from "@seshat/lean-search";
import { litFactory } from "@seshat/lit";
import { type HostProfile, hostProfilePath, leanCheckImplementation, loadCatalog, loadHostProfile, Registry } from "@seshat/registry";
import { type FakeLit, startFakeLit } from "../../lit/test/fake-lit.ts";
import { hostAt } from "../../lit/test/helpers.ts";
import {
  benchAdditions,
  consentOptions,
  DEFAULTS_SETS,
  describeSet,
  effectiveSwitches,
  REPO_ROOT,
  resolveAdditions,
  SOLVE_SWITCHES,
  solve,
  type SolveFlags,
  type SolveOptions,
  studentConfig,
} from "../src/index.ts";
import { check, DemoLean, fauxModels, ofType, tempDir } from "./m0-helpers.ts";

/** The defaults set `v2` of `harness solve` (Task 34b, decisions A to F): what it turns on, the answer on third parties, the switches. No Lean, model or network. */
const catalog = loadCatalog(join(REPO_ROOT, "capabilities"));
const eventsOf = (dir: string) => readEvents(join(dir, "journal.jsonl"));

class SearchLean implements LeanChecker {
  readonly implementation = "search-lean";
  readonly version = "0";
  private readonly inner = new DemoLean();
  async check(snippets: readonly LeanSnippet[], options: LeanCheckOptions = {}): Promise<LeanCheckResult[]> {
    if (!snippets.every((s) => s.id === "lean-search")) return this.inner.check(snippets, options);
    return snippets.map((s): LeanCheckResult => ({ id: s.id, status: "valid", messages: [], sorries: [], timeMs: 1 }));
  }
}

describe("what the sets turn on, from one source", () => {
  const flags = (f: SolveFlags = {}): SolveFlags => f;
  it("v1 turns none of the three on, v2 all three, from SOLVE_SWITCHES", () => {
    assert.deepEqual(effectiveSwitches(flags(), "v1"), { intake: false, autoTool: false, leanSearch: false, leanLsp: false });
    assert.deepEqual(effectiveSwitches(flags(), "v2"), { intake: true, autoTool: true, leanSearch: true, leanLsp: true });
    assert.deepEqual(SOLVE_SWITCHES.v2, { intake: true, autoTool: true, leanSearch: true, leanLsp: true });
  });

  it("keeps the explicit flags working with v1, and lets each --no-... turn one addition of v2 off alone", () => {
    assert.deepEqual(effectiveSwitches(flags({ intake: true, autoTool: true, leanSearch: true }), "v1"), { intake: true, autoTool: true, leanSearch: true, leanLsp: false });
    assert.deepEqual(effectiveSwitches(flags({ lit: true }), "v1"), { intake: true, autoTool: false, leanSearch: false, leanLsp: false });
    assert.deepEqual(effectiveSwitches(flags({ noIntake: true }), "v2"), { intake: false, autoTool: true, leanSearch: true, leanLsp: true });
    assert.deepEqual(effectiveSwitches(flags({ noAutoTool: true }), "v2"), { intake: true, autoTool: false, leanSearch: true, leanLsp: true });
    assert.deepEqual(effectiveSwitches(flags({ noLeanSearch: true }), "v2"), { intake: true, autoTool: true, leanSearch: false, leanLsp: true });
    assert.deepEqual(effectiveSwitches(flags({ noTools: ["lean.lsp"] }), "v2"), { intake: true, autoTool: true, leanSearch: true, leanLsp: false });
    assert.ok("conflict" in effectiveSwitches(flags({ noTools: ["compute.sage"] }), "v2"), "only lean.lsp can be dropped");
    for (const f of [flags({ intake: true, noIntake: true }), flags({ lit: true, noIntake: true }), flags({ autoTool: true, noAutoTool: true }), flags({ leanSearch: true, noLeanSearch: true })]) {
      assert.ok("conflict" in effectiveSwitches(f, "v2"), "a flag and its --no- cannot both be given");
    }
  });

  it("describes a set from the two tables, and the doctor's line says what a host does not offer", () => {
    const all = describeSet("v2").join("; ");
    for (const part of ["edit tool", "intake gate", "compute.sage", "lean.search", "repeat rule"]) assert.match(all, new RegExp(part));
    assert.deepEqual(describeSet("v1"), []);
    assert.match(describeSet("v2", () => false).join("; "), /compute\.sage.*does not offer it.*lean\.search.*does not offer it.*lean\.lsp.*does not offer it/s);
  });

  it("turns on the probe's extension in v2 and not in v1: the gate of v1 is what it was", () => {
    const of = (defaults: "v1" | "v2") => studentConfig({ selection: { ids: ["p"] }, model: "faux/m", maxUsd: 2, defaults }).gate;
    assert.deepEqual(of("v2"), { probeExtend: true });
    assert.deepEqual(of("v1"), {});
    assert.match(describeSet("v2").join("; "), /extension for a probe its cap cut/);
    assert.doesNotMatch(describeSet("v1").join("; "), /extension/);
  });

  it("keeps v1's RunConfig exactly as it was, and none of the three in the RunConfig of any set", () => {
    assert.deepEqual(DEFAULTS_SETS.v1, {});
    for (const set of Object.values(DEFAULTS_SETS)) for (const key of ["intake", "leanSearch", "autoTool", "tools"]) assert.equal(key in set, false);
    assert.equal("intake" in studentConfig({ selection: { ids: ["p"] }, model: "faux/m", maxUsd: 2, defaults: "v1" }), false);
  });

  it("gives v2 without lean.search or the compute tool one line each and goes on", () => {
    const none = resolveAdditions({}, "v2", effectiveSwitches({}, "v2") as { autoTool: boolean; leanSearch: boolean }, "local", () => false);
    assert.deepEqual([none.autoTool, none.leanSearch], [false, false]);
    assert.equal(none.notes.length, 3);
    assert.match(none.notes.join("\n"), /v2 defaults has nothing to add: host local does not offer compute\.sage[\s\S]*lean\.search; the run goes on without it/);
    const both = resolveAdditions({}, "v2", { autoTool: true, leanSearch: true }, "local", () => true);
    assert.deepEqual([both.autoTool, both.leanSearch, both.notes.length], [true, true, 0]);
    const lsp = (offers: boolean, defaults: "v1" | "v2") => resolveAdditions({}, defaults, effectiveSwitches({}, defaults) as { autoTool: boolean; leanSearch: boolean; leanLsp: boolean }, "local", (c) => c === "lean.lsp" && offers);
    assert.equal(lsp(true, "v2").leanLsp, true);
    assert.equal(lsp(false, "v2").leanLsp, false);
    assert.match(lsp(false, "v2").notes.join("\n"), /does not offer lean\.lsp/);
    assert.equal(lsp(true, "v1").leanLsp, false);
    assert.deepEqual(benchAdditions("v2", (c) => c === "lean.lsp").tools, ["lean.lsp"]);
    assert.equal(benchAdditions("v2", () => false).tools, undefined);
    assert.equal(benchAdditions("v1").tools, undefined);
    assert.equal(resolveAdditions({}, "v1", { autoTool: false, leanSearch: false }, "local", () => false).notes.length, 0, "v1 asks for nothing, so says nothing");
  });
});

describe("a v2 solve and the answer on third parties", () => {
  let site: FakeLit;
  before(async () => {
    site = await startFakeLit();
  });
  after(async () => {
    await site.close();
  });
  const profile = loadHostProfile(hostProfilePath(join(REPO_ROOT, "config"), "local"));
  const v2 = { intake: true, leanSearch: true };

  async function runV2(f: SolveFlags, io: Parameters<typeof consentOptions>[1], over: Partial<SolveOptions> = {}, canAsk = false) {
    const search: string[] = [];
    const fetch: Fetch = async (_input, init) => {
      search.push(String(init?.body ?? ""));
      return new Response(JSON.stringify([{ name: "Nat.add_zero" }]), { status: 200 });
    };
    const host: HostProfile = {
      host: "test",
      capabilities: {
        "lean.check": { use: ["kimina"] },
        "lit.search": hostAt(site.url).capabilities["lit.search"] as never,
        "lean.search": { use: ["search"], settings: { search: { allowedHosts: ["search.example"], remoteUrl: "https://search.example/api" } } },
      },
    };
    const lean = new SearchLean();
    const { models, faux, name } = fauxModels();
    faux.setResponses([check("bad"), check("bad"), check("exact trivial_proof")]);
    const dir = join(tempDir("mh-34b-"), "run");
    const litBefore = site.requests.length;
    await solve({
      statement: "theorem demo (n : ℕ) : n + 0 = n",
      dir,
      models,
      model: name,
      maxUsd: 2,
      user: "alice",
      registry: (journal, blobs) => new Registry({ catalog, host, factories: { kimina: () => leanCheckImplementation(lean), lit: litFactory(), "lean-search": leanSearchFactory({ fetch }) }, journal, blobs }),
      checker: lean,
      confirm: async () => true,
      base: { leanSearch: true },
      ...consentOptions({ ...f, ...v2 }, io, profile, canAsk),
      ...over,
    });
    return { events: eventsOf(dir), search, lit: site.requests.length - litBefore };
  }
  const consent = (events: ReturnType<typeof eventsOf>) => ofType(events, "intake.consented").map((e) => [e.data.allowed, e.data.via]);

  it("with --yes (or --ask-stdin) sends nothing to a third party and journals the no, while the hygiene tests still run", async () => {
    for (const f of [{ yes: true }, { askStdin: true }]) {
      const r = await runV2(f, {});
      assert.equal(r.lit, 0);
      assert.equal(r.search.length, 0);
      assert.deepEqual(consent(r.events), [[false, "default"]]);
      assert.ok(ofType(r.events, "intake.finished").length > 0, "the intake step ran");
    }
  });

  it("with --lit runs the literature and lets lean.search go remote; its judge call is capped at 5% of the allowance", async () => {
    const r = await runV2({ lit: true, yes: true }, {});
    assert.ok(r.lit > 0, "the literature was asked");
    assert.ok(r.search.length > 0, "lean.search went remote");
    assert.deepEqual(consent(r.events), [[true, "flag"]]);
    const started = ofType(r.events, "run.started")[0]?.data.config as { intake: { capShare: number } };
    assert.equal(started.intake.capShare, 0.05);
  });

  it("with --private wins over --lit: nothing goes out", async () => {
    const r = await runV2({ lit: true }, {}, { private: true });
    assert.equal(r.lit, 0);
    assert.equal(r.search.length, 0);
    assert.deepEqual(consent(r.events), [[false, "private"]]);
  });

  it("asks once where a person can answer, and a no keeps both to their local forms", async () => {
    let asked = 0;
    const no = await runV2({}, { ask: async () => (asked++, false) });
    assert.equal(asked, 1);
    assert.equal(no.lit + no.search.length, 0);
    assert.deepEqual(consent(no.events), [[false, "asked"]]);
    asked = 0;
    const yes = await runV2({}, { ask: async () => (asked++, true) });
    assert.equal(asked, 1);
    assert.ok(yes.lit > 0 && yes.search.length > 0);
  });

  it("with --no-intake the literature and its question are gone, with --no-lean-search the search is", () => {
    const noIntake = effectiveSwitches({ noIntake: true }, "v2") as { intake: boolean; leanSearch: boolean };
    const o = consentOptions({ ...noIntake, yes: false }, { ask: async () => true }, profile);
    assert.equal(o.intake, undefined, "no intake section");
    assert.equal(typeof o.askConsent, "function", "the search alone still wants the one question");
    const none = effectiveSwitches({ noIntake: true, noLeanSearch: true }, "v2") as { intake: boolean; leanSearch: boolean };
    assert.deepEqual(consentOptions({ ...none }, { ask: async () => true }, profile), {}, "nothing to ask");
  });
});
