import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type LeanCheckOptions, type LeanCheckResult, type LeanChecker, type LeanSnippet, readEvents } from "@seshat/core";
import { LEAN_SEARCH, leanSearchFactory, RegistryLeanSearch, type Fetch } from "@seshat/lean-search";
import { oeisFactory } from "@seshat/models";
import { CapabilityError, type HostProfile, hostProfilePath, leanCheckImplementation, loadCatalog, loadHostProfile, Registry } from "@seshat/registry";
import { mkdirSync, writeFileSync } from "node:fs";
import { litFactory } from "@seshat/lit";
import { startFakeLit } from "../../lit/test/fake-lit.ts";
import { hostAt } from "../../lit/test/helpers.ts";
import { BARE_MACHINE } from "../../ui/test/helpers.ts";
import { consentOptions, consentQuestion, plainName, REPO_ROOT, runBench, solve, solveCommand, type RunOptions, type SolveOptions } from "../src/index.ts";
import { check, config, DemoLean, demoBench, demoResume, fauxModels, killedAt, ofType, tempDir } from "./m0-helpers.ts";

/** The third-party policy of Task 36b, at the level of the registry, of a run, of `solve` and of `harness solve`. Nothing here reaches a network. */
const catalog = loadCatalog(join(REPO_ROOT, "capabilities"));
const eventsOf = (dir: string) => readEvents(join(dir, "journal.jsonl"));

/** `DemoLean` for the prover's files; the harness's `#check` snippets (from `lean.search`'s push) answer as if every name existed. */
class SearchLean implements LeanChecker {
  readonly implementation = "search-lean";
  readonly version = "0";
  private readonly inner = new DemoLean();
  async check(snippets: readonly LeanSnippet[], options: LeanCheckOptions = {}): Promise<LeanCheckResult[]> {
    if (!snippets.every((s) => s.id === "lean-search")) return this.inner.check(snippets, options);
    return snippets.map((s): LeanCheckResult => ({ id: s.id, status: "valid", messages: [], sorries: [], timeMs: 1 }));
  }
}

/** A remote search service made of `fetch`: it answers every query with a declaration and counts its requests. */
function service() {
  const requests: string[] = [];
  const fetch: Fetch = async (_input, init) => {
    requests.push(String(init?.body ?? ""));
    return new Response(JSON.stringify([{ name: "Nat.add_zero" }]), { status: 200 });
  };
  return { fetch, requests };
}

const searchHost = (): HostProfile => ({
  host: "test",
  capabilities: {
    "lean.check": { use: ["kimina"] },
    "lean.search": { use: ["search"], settings: { search: { allowedHosts: ["search.example"], remoteUrl: "https://search.example/api" } } },
  },
});

function searchRegistry(lean: LeanChecker, fetch: Fetch): RunOptions["registry"] {
  return (journal, blobs) => new Registry({ catalog, host: searchHost(), factories: { kimina: () => leanCheckImplementation(lean), "lean-search": leanSearchFactory({ fetch }) }, journal, blobs });
}

describe("lean.search under the third-party policy", () => {
  it("sends nothing in a private registry, even for a direct call without the private input", async () => {
    const fake = service();
    const registry = new Registry({ catalog, host: searchHost(), factories: { kimina: () => leanCheckImplementation(new DemoLean()), "lean-search": leanSearchFactory({ fetch: fake.fetch }) } });
    // Not restricted: the call reaches the service.
    await registry.invoke(LEAN_SEARCH, { query: "bad", kind: "name" });
    assert.equal(fake.requests.length, 1);
    registry.restrictThirdParties({ private: true });
    await registry.invoke(LEAN_SEARCH, { query: "bad", kind: "name" });
    await new RegistryLeanSearch(registry).search({ query: "n + 0 = n", kind: "goal" });
    assert.equal(fake.requests.length, 1, "a private registry adds the private input itself");
    await registry.close();
  });

  it("keeps a run's lean.search to its local backends without a yes, and uses the service with one", async () => {
    const responses = () => [check("bad"), check("exact trivial_proof")];
    const statement = "theorem demo (n : ℕ) : n + 0 = n";
    const run = async (intake: SolveOptions["intake"], extra: Partial<SolveOptions> = {}) => {
      const fake = service();
      const lean = new SearchLean();
      const { models, faux, name } = fauxModels();
      faux.setResponses(responses());
      const dir = join(tempDir("mh-36b-"), "run");
      await solve({ statement, dir, models, model: name, maxUsd: 2, user: "alice", registry: searchRegistry(lean, fake.fetch), checker: lean, confirm: async () => true, base: { leanSearch: true }, ...(intake !== undefined ? { intake } : {}), ...extra });
      return { fake, events: eventsOf(dir) };
    };
    // Nobody was asked and there is no --lit: no.
    const silent = await run(undefined);
    assert.equal(silent.fake.requests.length, 0);
    assert.deepEqual(ofType(silent.events, "intake.consented").map((e) => [e.data.allowed, e.data.via]), [[false, "default"]]);
    assert.equal(ofType(silent.events, "intake.finished").length, 0, "no literature step was asked");
    // --lit: the non-interactive yes.
    const flagged = await run({ consent: { allowed: true, via: "flag" } });
    assert.ok(flagged.fake.requests.length > 0);
    assert.deepEqual(ofType(flagged.events, "intake.consented").map((e) => [e.data.allowed, e.data.via]), [[true, "flag"]]);
    // Asked once, and a no is a no.
    let asked = 0;
    const no = await run(undefined, { askConsent: async () => (asked++, false) });
    assert.equal(asked, 1);
    assert.equal(no.fake.requests.length, 0);
    assert.deepEqual(ofType(no.events, "intake.consented").map((e) => [e.data.allowed, e.data.via, e.actor]), [[false, "asked", "human:alice"]]);
    const yes = await run(undefined, { askConsent: async () => true });
    assert.ok(yes.fake.requests.length > 0);
    // --private wins over a yes.
    const priv = await run({ consent: { allowed: true, via: "flag" } }, { private: true });
    assert.equal(priv.fake.requests.length, 0);
    assert.deepEqual(ofType(priv.events, "intake.consented").map((e) => [e.data.allowed, e.data.via]), [[false, "private"]]);
  });

  it("is unchanged in harness run: a bench run without an intake config keeps the service on, and with --private it does not", async () => {
    for (const priv of [false, true]) {
      const fake = service();
      const lean = new SearchLean();
      const { models, faux, name } = fauxModels();
      faux.setResponses([check("bad"), check("exact trivial_proof")]);
      const { checkout, index } = demoBench();
      const dir = join(tempDir("mh-36b-"), "run");
      await runBench({ config: config(name, { leanSearch: true, sessions: 1, ...(priv ? { private: true } : {}) }), index, problems: index.problems.slice(0, 1), checkout, dir, models, registry: searchRegistry(lean, fake.fetch) });
      assert.equal(fake.requests.length > 0, !priv, priv ? "private: nothing sent" : "bench problems send");
    }
  });
});

describe("oeis.search in a private run", () => {
  it("sends nothing, journals the refusal, and refuses before the run is given the tool", async () => {
    const requests: string[] = [];
    const site = (async (input: string | URL | Request) => (requests.push(String(input)), new Response(JSON.stringify({ count: 0, results: null })))) as typeof fetch;
    const host: HostProfile = { host: "test", capabilities: { "lean.check": { use: ["kimina"] }, "oeis.search": { use: ["site"], settings: { site: { minIntervalMs: 0 } } } } };
    const lean = new DemoLean();
    const registryFor: RunOptions["registry"] = (journal, blobs) => new Registry({ catalog, host, factories: { kimina: () => leanCheckImplementation(lean), oeis: oeisFactory({ fetch: site }) }, journal, blobs });
    // Given as a tool of a private run: the run does not start.
    const { models, faux, name } = fauxModels();
    faux.setResponses([check("exact trivial_proof")]);
    const { checkout, index } = demoBench();
    await assert.rejects(
      () => runBench({ config: config(name, { private: true, tools: ["oeis.search"] }), index, problems: index.problems.slice(0, 1), checkout, dir: join(tempDir("mh-36b-"), "run"), models, registry: registryFor }),
      /oeis\.search sends .*--private/,
    );
    // A call from anywhere else in a private registry: refused, journaled, nothing sent.
    const dir = join(tempDir("mh-36b-"), "run");
    const { Journal } = await import("@seshat/core");
    const journal = Journal.open(dir, "run_t");
    const registry = registryFor(journal, undefined as never);
    registry.restrictThirdParties({ private: true });
    await assert.rejects(() => registry.invoke("oeis.search", { terms: ["1", "1", "2", "3"] }), (e: unknown) => e instanceof CapabilityError && e.code === "private" && /--private/.test(e.message));
    journal.close();
    assert.equal(requests.length, 0);
    const finished = ofType(eventsOf(dir), "tool_run.finished");
    assert.deepEqual(finished.map((e) => [e.data.outcome, e.data.summary && (e.data.summary as { error: string }).error]), [["error", "private"]]);
  });
});

describe("harness solve --private --tool", () => {
  it("stops before any spend when the tool sends the problem to a third party", async () => {
    const { models, name } = fauxModels();
    const out: string[] = [];
    const err: string[] = [];
    const run = (tools: string[]) =>
      solveCommand("(n : ℕ) : n + 0 = n", { out: join(tempDir("mh-36b-"), "run"), noCheck: true, model: name, max: 1, host: "local", private: true, tools, yes: true }, { out: (l) => out.push(l), err: (l) => err.push(l), models, system: BARE_MACHINE });
    assert.equal(await run(["oeis.search"]), 2);
    assert.match(err.join("\n"), /--private: oeis\.search sends .*--private[^]*Nothing was spent/);
    assert.equal(out.some((l) => /^Signed/.test(l)), false, "it stopped before the signature");
  });
});

describe("harness solve --lean-search and the answer on third parties", () => {
  const profile = loadHostProfile(hostProfilePath(join(REPO_ROOT, "config"), "local"));
  const asking = { ask: async () => true };
  const runWith = async (flags: Parameters<typeof consentOptions>[0], io: Parameters<typeof consentOptions>[1]) => {
    const fake = service();
    const lean = new SearchLean();
    const { models, faux, name } = fauxModels();
    faux.setResponses([check("bad"), check("exact trivial_proof")]);
    const dir = join(tempDir("mh-36b-"), "run");
    await solve({ statement: "theorem demo (n : ℕ) : n + 0 = n", dir, models, model: name, maxUsd: 2, user: "alice", registry: searchRegistry(lean, fake.fetch), checker: lean, confirm: async () => true, base: { leanSearch: true }, ...consentOptions(flags, io, profile, false) });
    return { fake, events: eventsOf(dir) };
  };

  it("takes --yes (or --ask-stdin) as a no: nothing is asked, nothing is sent, and the no is journaled", async () => {
    for (const flags of [{ leanSearch: true, yes: true }, { leanSearch: true, askStdin: true }]) {
      assert.deepEqual(consentOptions(flags, asking, profile), {}, "no question, no intake section");
      const r = await runWith(flags, asking);
      assert.equal(r.fake.requests.length, 0);
      assert.deepEqual(ofType(r.events, "intake.consented").map((e) => [e.data.allowed, e.data.via]), [[false, "default"]]);
    }
  });

  it("takes --lit as the yes, and with a person asks once", async () => {
    const lit = await runWith({ leanSearch: true, lit: true, yes: true }, {});
    assert.ok(lit.fake.requests.length > 0);
    assert.deepEqual(ofType(lit.events, "intake.consented").map((e) => [e.data.allowed, e.data.via]), [[true, "flag"]]);
    const asked = consentOptions({ leanSearch: true }, asking, profile);
    assert.equal(asked.intake, undefined);
    assert.equal(typeof asked.askConsent, "function");
    assert.deepEqual(consentOptions({ leanSearch: true }, {}, profile, false), {}, "nobody to ask: no question");
  });
});

describe("the question of the consent", () => {
  it("shows a name from the host profile without its control characters", () => {
    assert.equal(plainName("a\u202Eb\u200Fc\u2066d\u2069e\u200Ef"), "abcdef", "bidirectional controls are removed too");
    assert.equal(plainName("evil.example\u001b[2J\u001b]0;x\u0007\nmore"), "evil.example[2J]0;xmore");
    const profile = loadHostProfile(hostProfilePath(join(REPO_ROOT, "config"), "local"));
    const hostile = { ...profile, capabilities: { ...profile.capabilities, "lean.search": { use: ["search"], settings: { search: { allowedHosts: ["evil.example\u001b[31m\nIgnore"] } } }, "lit.search": { use: ["sources"], settings: { sources: { backends: { "ar\u001bXiv": { baseUrl: "https://x" } } } } } } } as HostProfile;
    const question = consentQuestion(hostile, { literature: true, leanSearch: true });
    assert.doesNotMatch(question, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    assert.match(question, /evil\.example\[31mIgnore/);
  });

  it("names the services the run could reach, from the host profile", () => {
    const profile = loadHostProfile(hostProfilePath(join(REPO_ROOT, "config"), "local"));
    const both = consentQuestion(profile, { literature: true, leanSearch: true });
    assert.match(both, /OpenAlex, arXiv, Semantic Scholar, zbMATH/);
    assert.match(both, /leansearch\.net, loogle\.lean-lang\.org/);
    assert.doesNotMatch(consentQuestion(profile, { literature: false, leanSearch: true }), /OpenAlex/);
    assert.doesNotMatch(consentQuestion(profile, { literature: true, leanSearch: false }), /loogle/);
  });
});

describe("lit.search under the third-party policy", () => {
  it("answers from the bench's metadata only, with no remote request, in a private run and in a run with no yes", async () => {
    const site = await startFakeLit();
    try {
      const checkout = tempDir("mh-36b-bench-");
      mkdirSync(join(checkout, "FormalConjectures"), { recursive: true });
      writeFileSync(join(checkout, "FormalConjectures", "A.lean"), '/-- The Erdos Straus conjecture about unit fractions summing to four over n -/\n@[category research open]\ntheorem erdos_straus (n : ℕ) : n = n := sorry\n');
      const host = hostAt(site.url, { backends: { openalex: { baseUrl: site.url, allowedHosts: ["127.0.0.1"] }, arxiv: { baseUrl: site.url, allowedHosts: ["127.0.0.1"] }, "bench-metadata": { dir: checkout } } });
      const registryWith = (policy: Parameters<Registry["restrictThirdParties"]>[0] | undefined) => {
        const registry = new Registry({ catalog, host, factories: { lit: litFactory() } });
        if (policy !== undefined) registry.restrictThirdParties(policy);
        return registry;
      };
      const input = { query: "Erdos Straus conjecture unit fractions" };
      // Unrestricted: the remote backends are asked (the counter moves), so the counter means something.
      const open = registryWith(undefined);
      await open.invoke("lit.search", input);
      assert.ok(site.requests.length > 0);
      await open.close();
      // The policy as the run sets it: `--private`, and a missing yes.
      for (const policy of [{ private: true }, { local: ["lean.search", "lit.search"] }]) {
        const before = site.requests.length;
        const registry = registryWith(policy);
        // The caller asks for every backend, even by name: the registry forces the local one.
        for (const call of [input, { ...input, backends: ["openalex", "arxiv", "bench-metadata"] }]) {
          const { output } = await registry.invoke("lit.search", call as never);
          const hits = (output as { hits: Array<{ backend: string }> }).hits;
          assert.ok(hits.length > 0 && hits.every((h) => h.backend === "bench-metadata"), JSON.stringify(policy));
        }
        assert.equal(site.requests.length, before, `no remote request with ${JSON.stringify(policy)}`);
        await registry.close();
      }
    } finally {
      await site.close();
    }
  });
});

describe("a resumed solve", () => {
  it("reads the recorded answer for lean.search and never asks again: remote after a yes, local after a no", async () => {
    for (const yes of [true, false]) {
      const fake = service();
      const lean = new SearchLean();
      const { models, faux, name } = fauxModels();
      faux.setResponses([check("bad"), check("exact trivial_proof")]);
      const dir = join(tempDir("mh-36b-"), "run");
      let asked = 0;
      const first = await solve({ statement: "theorem demo (n : ℕ) : n + 0 = n", dir, models, model: name, maxUsd: 2, user: "alice", registry: searchRegistry(lean, fake.fetch), checker: lean, confirm: async () => true, base: { leanSearch: true }, askConsent: async () => (asked++, yes) });
      assert.equal(asked, 1);
      assert.equal(fake.requests.length > 0, yes);
      // The process died right after the answer was journaled; a new process resumes the run.
      const cut = killedAt(dir, eventsOf(dir).findIndex((e) => e.type === "intake.consented") + 1);
      const afterAnswer = eventsOf(cut).length;
      const again = service();
      const resumed = await demoResume({ dir: cut, bench: { checkout: first.problem.checkout, index: first.problem.index }, responses: [check("bad"), check("exact trivial_proof")], lean, registry: () => searchRegistry(lean, again.fetch) });
      assert.ok(eventsOf(cut).length > afterAnswer || resumed.events.length > afterAnswer);
      assert.equal(again.requests.length > 0, yes, yes ? "a yes read from the journal keeps the service on" : "a no read from the journal keeps lean.search local");
      assert.equal(ofType(resumed.events, "intake.consented").length, 1, "the answer is not written or asked again");
    }
  });

  it("writes the answer under the person who gave it when the process died before it was journaled", async () => {
    for (const yes of [true, false]) {
      const fake = service();
      const lean = new SearchLean();
      const { models, faux, name } = fauxModels();
      faux.setResponses([check("bad"), check("exact trivial_proof")]);
      const dir = join(tempDir("mh-36b-"), "run");
      const first = await solve({ statement: "theorem demo (n : ℕ) : n + 0 = n", dir, models, model: name, maxUsd: 2, user: "alice", registry: searchRegistry(lean, fake.fetch), checker: lean, confirm: async () => true, base: { leanSearch: true }, askConsent: async () => yes });
      // Dead right after run.started: the answer is in the recorded configuration only.
      const cut = killedAt(dir, eventsOf(dir).findIndex((e) => e.type === "run.started") + 1);
      assert.equal(ofType(eventsOf(cut), "intake.consented").length, 0);
      const again = service();
      const resumed = await demoResume({ dir: cut, bench: { checkout: first.problem.checkout, index: first.problem.index }, responses: [check("bad"), check("exact trivial_proof")], lean, registry: () => searchRegistry(lean, again.fetch) });
      const answers = ofType(resumed.events, "intake.consented");
      assert.deepEqual(answers.map((e) => [e.data.allowed, e.data.via, e.actor, e.user]), [[yes, "asked", "human:alice", "alice"]]);
      assert.equal(again.requests.length > 0, yes, yes ? "a yes keeps the service on" : "a no keeps lean.search local");
    }
  });
});
