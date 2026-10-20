import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  BlobStore,
  type CertificationRequest,
  type CertificationResult,
  CertifyFailedError,
  type HarnessEvent,
  Journal,
  type LeanCertifier,
  type LeanChecker,
  PROOF_BEGIN,
  prepareSketch,
  ProofValidator,
  SKETCH_POLICY,
  toPlainHeader,
} from "@seshat/core";
import type { Line } from "@seshat/lines";
import { claimSource, claimTheoremName } from "@seshat/memory";
import { type HostProfile, leanCertifyImplementation, leanCheckImplementation, loadCatalog, Registry, RegistryLeanChecker, UnavailableError } from "@seshat/registry";
import { REPO_ROOT, type RunOptions, Workbench } from "../src/index.ts";
import { LINES } from "../src/lines.ts";
import { check, DEMO_FILE, DemoLean, demoRegistry, demoRun, ofType, say, tempDir } from "./m0-helpers.ts";

/** A certifier that answers `verdict` to every request, and keeps the requests. */
function certifier(verdict: "certified" | "rejected" = "certified", reasons: string[] = ["kernel: declaration has metavariables"]) {
  const requests: CertificationRequest[] = [];
  const made: LeanCertifier = {
    implementation: "fake-certifier",
    version: "0",
    certify: async (request): Promise<CertificationResult> => {
      requests.push(request);
      return { verdict, reasons: verdict === "certified" ? [] : reasons, axioms: ["propext"], timeMs: 1 };
    },
  };
  return { requests, certifier: made };
}

/** A line that runs `beforeProvers` and `afterProblem` with the problem's context. */
function acting(hooks: Pick<Line["hooks"], "beforeProvers" | "afterProblem">): Line {
  return { id: "M1", title: "the test line", requires: [], hooks };
}

/**
 * A line that writes down each point where the lines' hooks run, and changes nothing. In the order
 * of the lines M10 comes after M1 and before M6 and the fleet, so it is called as they are.
 */
function watcher(seen: string[]): Line {
  return {
    id: "M10",
    title: "a watcher of the tests",
    requires: [],
    hooks: {
      beforeSession: async (s) => { seen.push(`beforeSession ${s.prover}/${s.session}`); return undefined; },
      beforeCheck: async (_s, proposal) => { seen.push(`beforeCheck ${proposal.proof.trim()}`); return undefined; },
      afterCheck: async (_s, c) => { seen.push(`afterCheck ${c.accepted ? "accepted" : "not accepted"}`); return undefined; },
      afterAttempt: async (_p, a) => { seen.push(`afterAttempt ${a.prover} ${a.outcome}`); return undefined; },
      afterProver: async (_p, end) => { seen.push(`afterProver ${end.prover} ${end.stop}`); },
      afterProblem: async (_p, end) => { seen.push(`afterProblem ${end.outcome}`); },
    },
  };
}

/** `certifier()`, which writes "certify" in `seen` when it is asked. */
function noted(seen: string[], verdict: "certified" | "rejected" = "certified") {
  const { certifier: inner, requests } = certifier(verdict);
  const asked: LeanCertifier = { ...inner, certify: async (request, options) => { seen.push("certify"); return inner.certify(request, options); } };
  return { requests, certifier: asked };
}

const IMPORTS = "import FormalConjectures.Util.ProblemImports\n\nnamespace Demo\n\n";

/** A problem file: the prefix, then a solved problem. */
function problemFile(theorem: string): string {
  return `${IMPORTS}/-- Adding zero changes nothing. -/\n@[category research solved, AMS 11]\n${theorem} := by\n  sorry\n\nend Demo\n`;
}

/** Two files that read the same: one prefix, and one statement, spaced differently. */
const TWICE = {
  "Demo.lean": problemFile("theorem add_zero' (n : ℕ) : n + 0 = n"),
  "DemoAgain.lean": problemFile("theorem add_zero_again (n : ℕ)  :  n + 0 = n"),
};

/** The position of an event in the journal. */
function at(events: readonly HarnessEvent[], event: HarnessEvent | undefined): number {
  assert.ok(event !== undefined);
  return events.indexOf(event);
}

const catalog = loadCatalog(join(REPO_ROOT, "capabilities"));

const certifyHost: HostProfile = { host: "test", capabilities: { "lean.check": { use: ["kimina"] }, "lean.certify": { use: ["lake"] } } };

/** A host that lists `lean.certify`, served by `certifier` through the registry, as a deployment would. */
function certifyingHost(certifier: LeanCertifier): (lean: LeanChecker) => RunOptions["registry"] {
  return (lean) => (journal, blobs) =>
    new Registry({
      catalog,
      host: certifyHost,
      factories: { kimina: () => leanCheckImplementation(lean), "lake-certify": () => leanCertifyImplementation(certifier) },
      journal,
      blobs,
    });
}

describe("certification in a run", () => {
  it("makes a claim proved only after the certifier has certified it", async () => {
    const { certifier: certified, requests } = certifier();
    const proved = await demoRun({ certifier: certified, responses: [check("exact trivial_proof")] });
    assert.equal(proved.result.problems[0]?.outcome, "proved");
    const validations = ofType(proved.events, "validation.finished");
    assert.deepEqual(validations.map((v) => [v.data.method, v.data.verdict, v.actor]), [
      ["repl", "valid", "validator"],
      ["kernel_replay", "valid", "fake-certifier"],
    ]);
    // The status changes in this order, each on the validation that justifies it.
    const changes = ofType(proved.events, "claim.status_changed");
    assert.deepEqual(changes.map((c) => [c.data.from, c.data.to, c.data.validationId]), [
      ["open", "computed", validations[0]?.data.validationId],
      ["computed", "proved", validations[1]?.data.validationId],
    ]);
    assert.ok(at(proved.events, validations[1]) < at(proved.events, changes[1]));
    assert.deepEqual([ofType(proved.events, "run.finished")[0]?.data.solved, ofType(proved.events, "run.finished")[0]?.data.candidates], [1, 0]);
    assert.equal(requests.length, 1);

    // Without a certifier the same proof stays a candidate: nothing is proved on the fast check.
    const said: string[] = [];
    const alone = await demoRun({ responses: [check("exact trivial_proof")], log: (line) => said.push(line) });
    assert.ok(said.includes("no certifier on host test: a proof that passes the fast check stays a candidate"), said.join("\n"));
    assert.equal(alone.result.problems[0]?.outcome, "candidate");
    assert.equal(alone.result.problems[0]?.reason, undefined);
    assert.deepEqual(ofType(alone.events, "claim.status_changed").map((c) => c.data.to), ["computed"]);
    assert.deepEqual(ofType(alone.events, "validation.finished").map((v) => v.data.method), ["repl"]);
  });

  it("gives the certifier the problem's file, the candidate that passed, and the policy's axioms", async () => {
    const { certifier: certified, requests } = certifier();
    const { dir } = await demoRun({ certifier: certified, responses: [check("exact trivial_proof")] });
    assert.equal(requests.length, 1);
    const [request] = requests as [CertificationRequest];
    assert.equal(request.original, toPlainHeader(DEMO_FILE));
    assert.equal(request.target, "Demo.add_zero'");
    assert.deepEqual(request.allowedAxioms, SKETCH_POLICY.allowedAxioms);
    assert.ok(request.candidate.includes(PROOF_BEGIN) && request.candidate.includes("exact trivial_proof"));
    // It is the file that was written as the problem's proof.
    assert.equal(readFileSync(join(dir, "proofs", readProofName(dir)), "utf8"), request.candidate);
  });

  it("leaves the problem a candidate when the certifier gives no answer, and records no verdict", async () => {
    for (const reason of ["timeout", "unavailable", "failed", "aborted"] as const) {
      const silent: LeanCertifier = {
        implementation: "fake-certifier",
        version: "0",
        certify: async () => Promise.reject(new CertifyFailedError(reason, `the certifier said ${reason}`)),
      };
      const { result, events } = await demoRun({ certifier: silent, responses: [check("exact trivial_proof")] });
      assert.equal(result.problems[0]?.outcome, "candidate", reason);
      assert.equal(result.problems[0]?.reason, `certification failed: the certifier said ${reason}`);
      assert.deepEqual(ofType(events, "validation.finished").map((v) => v.data.method), ["repl"], reason);
      assert.deepEqual(ofType(events, "claim.status_changed").map((c) => c.data.to), ["computed"], reason);
      assert.deepEqual([ofType(events, "run.finished")[0]?.data.solved, ofType(events, "run.finished")[0]?.data.candidates], [0, 1], reason);
    }
  });

  it("certifies through the host's lean.certify when its profile lists one", async () => {
    const { certifier: lake, requests } = certifier();
    const logged: string[] = [];
    const { result, events } = await demoRun({ registry: certifyingHost(lake), responses: [check("exact trivial_proof")], log: (line) => logged.push(line) });
    assert.equal(result.problems[0]?.outcome, "proved");
    assert.equal(requests.length, 1);
    assert.ok(logged.some((line) => /^certifier: lean\.certify\/lake \d/.test(line)), logged.join("\n"));
    // The run records the certifier it used, and the certification is a tool run of the host's.
    const config = ofType(events, "run.started")[0]?.data.config as { certifier: string };
    assert.match(config.certifier, /^lean\.certify\/lake \d/);
    assert.equal(ofType(events, "tool_run.started").filter((e) => e.data.capability === "lean.certify").length, 1);
    assert.deepEqual(ofType(events, "validation.finished").map((v) => [v.data.method, v.data.verdict]), [["repl", "valid"], ["kernel_replay", "valid"]]);

    // A host whose certifier cannot be reached leaves the candidate a candidate, with the reason.
    const down: LeanCertifier = {
      implementation: "down",
      version: "0",
      certify: async () => Promise.reject(new CertifyFailedError("unavailable", "no Lean project")),
    };
    const failing = await demoRun({ registry: certifyingHost(down), responses: [check("exact trivial_proof")] });
    assert.equal(failing.result.problems[0]?.outcome, "candidate");
    assert.match(failing.result.problems[0]?.reason ?? "", /^certification failed: .*no Lean project/);
    assert.deepEqual(ofType(failing.events, "claim.status_changed").map((c) => c.data.to), ["computed"]);
  });
});

describe("a host whose certifier cannot be made", () => {
  const REASON = "lean.certify refuses to run the candidate's code without a sandbox: give it a sandbox command, or set unsandboxed: true";
  const refusing = (lean: LeanChecker): RunOptions["registry"] => (journal, blobs) =>
    new Registry({
      catalog,
      host: certifyHost,
      factories: {
        kimina: () => leanCheckImplementation(lean),
        "lake-certify": () => {
          throw new UnavailableError(REASON);
        },
      },
      journal,
      blobs,
    });

  it("is said at the start of the run and recorded in it, and leaves the candidates candidates with the reason", async () => {
    const logged: string[] = [];
    const { result, events } = await demoRun({ registry: refusing, responses: [check("exact trivial_proof")], log: (line) => logged.push(line) });
    assert.ok(
      logged.some((line) => /^certifier lean\.certify\/lake \d\S* is unavailable on host test \(lake: lean\.certify refuses to run the candidate's code without a sandbox/.test(line)),
      logged.join("\n"),
    );
    assert.ok(!logged.some((line) => line.startsWith("certifier: ")), "it is not announced as the run's certifier");
    const config = ofType(events, "run.started")[0]?.data.config as { certifier: string; certifierUnavailable?: string };
    assert.match(config.certifier, /^lean\.certify\/lake \d/);
    assert.equal(config.certifierUnavailable, `lake: ${REASON}`);
    // The problem is a candidate, and its reason is the certifier's.
    assert.equal(result.problems[0]?.outcome, "candidate");
    assert.match(result.problems[0]?.reason ?? "", /^certification failed: .*refuses to run the candidate's code without a sandbox/);
    assert.deepEqual(ofType(events, "validation.finished").map((v) => v.data.method), ["repl"]);
    assert.deepEqual(ofType(events, "claim.status_changed").map((c) => c.data.to), ["computed"]);
  });

  it("is not said of a certifier that can be made, or of a run that was given its own", async () => {
    const { certifier: lake } = certifier();
    const logged: string[] = [];
    const { events } = await demoRun({ registry: certifyingHost(lake), responses: [check("exact trivial_proof")], log: (line) => logged.push(line) });
    assert.ok(!logged.some((line) => /is unavailable/.test(line)), logged.join("\n"));
    assert.equal("certifierUnavailable" in (ofType(events, "run.started")[0]?.data.config as object), false);
    // A certifier the caller gives is the caller's: the host's profile is not asked.
    const given = await demoRun({ registry: refusing, certifier: lake, responses: [check("exact trivial_proof")] });
    assert.equal("certifierUnavailable" in (ofType(given.events, "run.started")[0]?.data.config as object), false);
    assert.equal(given.result.problems[0]?.outcome, "proved");
  });
});

describe("certification in a run with M1, M6 and the fleet", () => {
  /** Two provers, so that the fleet's gate has one to hold back. The watcher is the line M10. */
  const ON = { lines: ["M1", "M10", "M6", "fleet"], provers: 2, sessions: 2, lineOptions: { fleet: { seed: 1 } } as never };

  it("certifies the candidate once the provers are done, and no hook of the lines sees the certification", async () => {
    const seen: string[] = [];
    const { certifier: asked, requests } = noted(seen);
    const { result, events } = await demoRun({ lines: { ...LINES, M10: watcher(seen) }, config: ON, certifier: asked, responses: [check("exact trivial_proof")] });
    assert.equal(result.problems[0]?.outcome, "proved");
    // Every hook of a session or a prover ran before the certifier was asked, and the only hook after
    // it is `afterProblem`, which is told the result.
    const asking = seen.indexOf("certify");
    assert.deepEqual(seen.slice(asking), ["certify", "afterProblem proved"]);
    assert.ok(seen.slice(0, asking).every((s) => /^(beforeSession|beforeCheck|afterCheck|afterAttempt|afterProver) /.test(s)), seen.join("\n"));
    // The guards saw the model's one call and its one check, and nothing else.
    assert.deepEqual(seen.filter((s) => /^(beforeCheck|afterCheck) /.test(s)), ["beforeCheck exact trivial_proof", "afterCheck accepted"]);
    // The certifier was given the file that passed, and the claim is proved on its validation.
    assert.equal(requests.length, 1);
    assert.ok(requests[0]?.candidate.includes("exact trivial_proof"));
    assert.deepEqual(ofType(events, "validation.finished").map((v) => [v.data.method, v.data.verdict]), [["repl", "valid"], ["kernel_replay", "valid"]]);
    assert.deepEqual(ofType(events, "claim.status_changed").map((c) => c.data.to), ["computed", "proved"]);
    // M6 flagged nothing: the fleet's allocations are the only nodes the lines recorded.
    assert.deepEqual(ofType(events, "node.recorded").map((e) => e.data.kind).filter((kind) => kind !== "allocation"), []);
  });

  it("leaves the problem unsolved when the kernel rejects it, and afterProblem is told so", async () => {
    const seen: string[] = [];
    const { certifier: asked, requests } = noted(seen, "rejected");
    const { result, events } = await demoRun({ lines: { ...LINES, M10: watcher(seen) }, config: ON, certifier: asked, responses: [check("exact trivial_proof")] });
    assert.equal(result.problems[0]?.outcome, "unsolved");
    assert.match(result.problems[0]?.reason ?? "", /^certification rejected the candidate: /);
    assert.equal(requests.length, 1);
    assert.deepEqual(seen.slice(seen.indexOf("certify")), ["certify", "afterProblem unsolved"]);
    assert.deepEqual(ofType(events, "claim.status_changed").map((c) => c.data.to), ["computed"]);
    assert.deepEqual(ofType(events, "validation.finished").map((v) => [v.data.method, v.data.verdict]), [["repl", "valid"], ["kernel_replay", "invalid"]]);
  });

  it("does not let a veto of M6 reach the certification: only the file that was checked is certified", async () => {
    const seen: string[] = [];
    const { certifier: asked, requests } = noted(seen);
    const { result, events } = await demoRun({
      lines: { ...LINES, M10: watcher(seen) },
      config: ON,
      certifier: asked,
      responses: [check("-- this is a well-known result\nexact trivial_proof"), check("exact trivial_proof")],
    });
    assert.equal(result.problems[0]?.outcome, "proved");
    // M6 vetoed the first call, which is no check: no validation, no candidate, nothing to certify.
    assert.equal(seen.filter((s) => s.startsWith("beforeCheck")).length, 2);
    assert.deepEqual(seen.filter((s) => s.startsWith("afterCheck")), ["afterCheck accepted"]);
    assert.equal(requests.length, 1);
    assert.ok(!requests[0]?.candidate.includes("well-known"));
    assert.deepEqual(ofType(events, "validation.finished").map((v) => [v.data.method, v.data.verdict]), [["repl", "valid"], ["kernel_replay", "valid"]]);
    assert.deepEqual(seen.slice(seen.indexOf("certify")), ["certify", "afterProblem proved"]);
  });

  it("goes through the registry as a call that belongs to no attempt, so the report does not count it among the provers' tools", async () => {
    const { certifier: lake, requests } = certifier();
    const { result, events, dir } = await demoRun({
      registry: certifyingHost(lake),
      config: ON,
      lines: { ...LINES, M10: watcher([]) },
      responses: [check("exact trivial_proof")],
    });
    assert.equal(result.problems[0]?.outcome, "proved");
    assert.equal(requests.length, 1);
    const runs = ofType(events, "tool_run.started").filter((e) => e.data.capability === "lean.certify");
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.data.attemptId, undefined);
    assert.ok(at(events, runs[0]) > at(events, ofType(events, "attempt.finished").at(-1)));
    const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as { tools: Record<string, unknown> };
    assert.deepEqual(Object.keys(report.tools), []);
  });
});

describe("refutations in a run", () => {
  it("certifies a refutation a line submitted, and ends the problem refuted", async () => {
    const { certifier: certified, requests } = certifier();
    let reference = "";
    const line = acting({
      beforeProvers: async (problem) => {
        reference = problem.memory.referenceFor(problem.claimId, { negation: true }).source;
        const result = await problem.validate({ claimId: problem.claimId, negation: true, proof: "exact trivial_proof" });
        assert.deepEqual([result.verdict, result.status], ["valid", "open"], "a refutation that passes the fast check settles nothing");
      },
    });
    const { result, events } = await demoRun({
      lines: { M1: line },
      config: { lines: ["M1"], sessions: 1 },
      certifier: certified,
      responses: [say("I found no proof.")],
    });
    const claimId = ofType(events, "problem.registered")[0]?.data.claimId;
    assert.equal(result.problems[0]?.outcome, "refuted");
    assert.equal(ofType(events, "problem.finished")[0]?.data.outcome, "refuted");

    const validations = ofType(events, "validation.finished");
    assert.deepEqual(validations.map((v) => [v.data.method, v.data.verdict, v.data.negation ?? false]), [
      ["repl", "valid", true],
      ["kernel_replay", "valid", true],
    ]);
    const changes = ofType(events, "claim.status_changed").filter((c) => c.data.claimId === claimId);
    assert.deepEqual(changes.map((c) => [c.data.from, c.data.to, c.data.validationId]), [["open", "refuted", validations[1]?.data.validationId]]);
    // The certifier compared the refutation with the file of the negation, rebuilt by the memory.
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.original, reference);
    assert.match(requests[0]?.target ?? "", /^add_zero'_negation$/);
    assert.match(requests[0]?.candidate ?? "", /exact trivial_proof/);

    // The run counts it, apart from the proofs.
    const finished = ofType(events, "run.finished")[0]?.data;
    assert.deepEqual([finished?.solved, finished?.refuted, finished?.candidates], [0, 1, 0]);
    assert.equal(result.report.outcomes.refuted, 1);
    assert.equal(typeof result.report.usdPerProof, "number");
    assert.match(readFileSync(join(result.dir, "report.md"), "utf8"), /^\| Refuted \(certified\) \| 1 \|$/m);
  });

  it("records a refutation the certifier rejects, and leaves the claim as it was", async () => {
    const { certifier: rejecting } = certifier("rejected", ["the module uses the axiom sorryAx"]);
    const line = acting({
      beforeProvers: async (problem) => void (await problem.validate({ claimId: problem.claimId, negation: true, proof: "exact trivial_proof" })),
    });
    const { result, events } = await demoRun({
      lines: { M1: line },
      config: { lines: ["M1"], sessions: 1 },
      certifier: rejecting,
      responses: [say("I found no proof.")],
    });
    assert.equal(result.problems[0]?.outcome, "unsolved");
    const validations = ofType(events, "validation.finished");
    assert.deepEqual(validations.map((v) => [v.data.method, v.data.verdict, v.data.negation ?? false, v.data.reasons]), [
      ["repl", "valid", true, []],
      ["kernel_replay", "invalid", true, ["the module uses the axiom sorryAx"]],
    ]);
    assert.deepEqual(ofType(events, "claim.status_changed"), []);
    assert.equal(ofType(events, "run.finished")[0]?.data.refuted, 0);
  });

  it("does not call the claim proved when its refutation was certified first", async () => {
    // Two problems with one statement share a claim. The first is refuted by its line; the second
    // finds a proof that passes the fast check and that the certifier certifies too. The claim
    // cannot be both: it stays refuted, and the second problem reports the contradiction.
    const { certifier: certified } = certifier();
    const line = acting({
      beforeProvers: async (problem) => {
        if (problem.target.theorem !== "Demo.add_zero'") return;
        await problem.validate({ claimId: problem.claimId, negation: true, proof: "exact trivial_proof" });
      },
    });
    const { result, events } = await demoRun({
      file: TWICE,
      problems: 2,
      lines: { M1: line },
      config: { lines: ["M1"], sessions: 1 },
      certifier: certified,
      responses: [say("I found no proof."), check("exact trivial_proof")],
    });
    assert.deepEqual(result.problems.map((p) => p.outcome), ["refuted", "error"]);
    assert.match(result.problems[1]?.reason ?? "", /the candidate was certified, but its claim is refuted/);
    const claims = ofType(events, "claim.created");
    assert.equal(claims.length, 1);
    assert.deepEqual(ofType(events, "claim.status_changed").map((c) => c.data.to), ["refuted"]);
    // The certification of the second problem's proof is on record, since it is evidence.
    assert.deepEqual(ofType(events, "validation.finished").map((v) => [v.data.method, v.data.negation ?? false]), [
      ["repl", true],
      ["kernel_replay", true],
      ["repl", false],
      ["kernel_replay", false],
    ]);
  });
});

describe("what the lines submit for other claims", () => {
  it("certifies it when the problem's lines are done, from the reference rebuilt by the memory", async () => {
    const { certifier: certified, requests } = certifier();
    const forged = { source: "theorem anything : True := trivial\n", theorem: "anything" };
    const header = "import Mathlib";
    const statement = "(n : ℕ) : 0 + n = n";
    const late = "(n : ℕ) : n * 1 = n";
    const refusals: string[] = [];
    const ids: { other?: string; late?: string } = {};
    const line = acting({
      beforeProvers: async (problem) => {
        ids.other = (await problem.memory.ensureClaim({ statement, header, origin: "test" })).claimId;
        // A line cannot give a claim a file of its own, nor change the one it reads.
        for (const claimId of [ids.other, problem.claimId]) {
          try {
            problem.memory.setReference(claimId, forged);
          } catch (error) {
            refusals.push((error as Error).message);
          }
        }
        problem.memory.referenceFor(ids.other).source = forged.source;
        const result = await problem.validate({ claimId: ids.other, proof: "exact trivial_proof" });
        assert.deepEqual([result.verdict, result.status], ["valid", "computed"], "a proof of another claim is a candidate until it is certified");
      },
      afterProblem: async (problem) => {
        ids.late = (await problem.memory.ensureClaim({ statement: late, header, origin: "test" })).claimId;
        await problem.validate({ claimId: ids.late, proof: "exact trivial_proof" });
      },
    });
    const { result, events } = await demoRun({
      lines: { M1: line },
      config: { lines: ["M1"], sessions: 1 },
      certifier: certified,
      responses: [check("exact trivial_proof")],
    });
    const other = ids.other as string;
    const lateId = ids.late as string;
    assert.equal(result.problems[0]?.outcome, "proved");
    assert.equal(refusals.length, 2);
    for (const message of refusals) assert.match(message, /is a view; only the orchestrator's root store sets a reference file/);

    // The problem's own candidate is certified first, before its lines are done; the others after.
    const target = ofType(events, "problem.registered")[0]?.data.claimId;
    const kernel = ofType(events, "validation.finished").filter((v) => v.data.method === "kernel_replay");
    assert.deepEqual(kernel.map((v) => v.data.claimId), [target, other, lateId]);
    const lateCreated = ofType(events, "claim.created").find((c) => c.data.claimId === lateId);
    assert.ok(at(events, kernel[0]) < at(events, lateCreated), "the problem's own candidate is certified before afterProblem");
    assert.ok(
      at(events, lateCreated) < at(events, kernel[1]) && at(events, kernel[2]) < at(events, ofType(events, "problem.finished")[0]),
      "the others come after it, before the problem ends",
    );
    assert.deepEqual(
      ofType(events, "claim.status_changed").filter((c) => c.data.to === "proved").map((c) => [c.data.claimId, c.data.validationId]),
      kernel.map((v) => [v.data.claimId, v.data.validationId]),
    );

    // Each was compared with the file rebuilt from the claim's journaled statement and header.
    const request = (claimId: string) => requests.find((r) => r.target === claimTheoremName(claimId));
    assert.equal(request(other)?.original, claimSource(header, claimTheoremName(other), statement));
    assert.equal(request(lateId)?.original, claimSource(header, claimTheoremName(lateId), late));
    assert.equal(request(target as string), undefined, "the problem's own claim goes by its file, not by the generated one");
    assert.equal(requests.find((r) => r.target === "Demo.add_zero'")?.original, toPlainHeader(DEMO_FILE));
  });

  it("leaves it a candidate when the certifier rejects it, and the problem as it was", async () => {
    const answers: Array<"certified" | "rejected"> = ["certified", "rejected"];
    const requests: CertificationRequest[] = [];
    const picky: LeanCertifier = {
      implementation: "fake-certifier",
      version: "0",
      certify: async (request) => {
        requests.push(request);
        const verdict = answers[requests.length - 1] ?? "certified";
        return { verdict, reasons: verdict === "certified" ? [] : ["kernel: type mismatch"], axioms: [], timeMs: 1 };
      },
    };
    let other = "";
    const logged: string[] = [];
    const line = acting({
      beforeProvers: async (problem) => {
        other = (await problem.memory.ensureClaim({ statement: "(n : ℕ) : 0 + n = n", header: "import Mathlib", origin: "test" })).claimId;
        await problem.validate({ claimId: other, proof: "exact trivial_proof" });
      },
    });
    const { result, events } = await demoRun({
      lines: { M1: line },
      config: { lines: ["M1"], sessions: 1 },
      certifier: picky,
      responses: [check("exact trivial_proof")],
      log: (text) => logged.push(text),
    });
    assert.equal(result.problems[0]?.outcome, "proved");
    const status = ofType(events, "claim.status_changed").filter((c) => c.data.claimId === other).map((c) => c.data.to);
    assert.deepEqual(status, ["computed"]);
    const verdicts = ofType(events, "validation.finished").filter((v) => v.data.claimId === other).map((v) => [v.data.method, v.data.verdict, v.data.reasons]);
    assert.deepEqual(verdicts, [["repl", "valid", []], ["kernel_replay", "invalid", ["kernel: type mismatch"]]]);
    assert.ok(logged.some((l) => l.includes(`the certifier rejected the proof of claim ${other}: kernel: type mismatch`)), logged.join("\n"));
  });

  it("does not start a certification once the run is stopped", async () => {
    const { certifier: certified, requests } = certifier();
    const controller = new AbortController();
    let other = "";
    const line = acting({
      afterProblem: async (problem) => {
        other = (await problem.memory.ensureClaim({ statement: "(n : ℕ) : 0 + n = n", header: "import Mathlib", origin: "test" })).claimId;
        await problem.validate({ claimId: other, proof: "exact trivial_proof" });
        controller.abort();
      },
    });
    const { result, events } = await demoRun({
      lines: { M1: line },
      config: { lines: ["M1"], sessions: 1 },
      certifier: certified,
      signal: controller.signal,
      responses: [check("exact trivial_proof")],
    });
    // The problem's own candidate was certified before the stop; the other claim's stays a candidate.
    assert.equal(result.problems[0]?.outcome, "proved");
    assert.equal(requests.length, 1);
    assert.deepEqual(ofType(events, "claim.status_changed").filter((c) => c.data.claimId === other).map((c) => c.data.to), ["computed"]);
  });
});

/** The name of the single proof file a run wrote. */
function readProofName(dir: string): string {
  const [name] = readdirSync(join(dir, "proofs"));
  return name as string;
}

describe("Workbench.certify", () => {
  /** A workbench on the demo problem's claim, with a journal of its own. */
  async function workbench(certifier: LeanCertifier) {
    const dir = tempDir();
    const journal = Journal.open(dir, "run_test");
    const blobs = new BlobStore(join(dir, "blobs"));
    const registry = demoRegistry(new DemoLean())(journal, blobs);
    const source = toPlainHeader(DEMO_FILE);
    const sketch = prepareSketch(source, "Demo.add_zero'");
    const reference = await new ProofValidator(new RegistryLeanChecker(registry), { policy: SKETCH_POLICY }).reference(sketch, source);
    const statement = "(n : ℕ) : n + 0 = n";
    journal.emit("claim.created", { claimId: "clm_a", statementId: `st9:${statement}`, statement, origin: "test", status: "open" }, "test");
    const made = new Workbench({ journal, registry, problem: { source, sketch }, claimId: "clm_a", reference, blobs, certifier });
    const candidate = () => made.check({ aux: "", proof: "exact trivial_proof" }, { actor: "test" });
    return { journal, made, candidate, status: () => journal.projection.claim("clm_a")?.status };
  }

  it("certifies a candidate once, however often and however fast it is asked", async () => {
    const { certifier: counted, requests } = certifier();
    const { journal, made, candidate, status } = await workbench(counted);
    assert.equal(made.awaitsCertification, false, "no candidate yet");
    assert.equal(await made.certify(), undefined);
    assert.equal((await candidate()).accepted, true);
    assert.equal(made.awaitsCertification, true);

    const [first, second] = await Promise.all([made.certify(), made.certify()]);
    assert.equal(first, second);
    assert.equal(await made.certify(), first);
    assert.equal(made.awaitsCertification, false);
    assert.equal(requests.length, 1);
    assert.deepEqual([first?.result.verdict, first?.status, status()], ["certified", "proved", "proved"]);
    assert.equal(journal.projection.validations("clm_a").filter((v) => v.method === "kernel_replay").length, 1);
    journal.close();
  });

  it("remembers a failure too, so that a certifier that is down is asked once", async () => {
    let calls = 0;
    const down: LeanCertifier = {
      implementation: "down",
      version: "0",
      certify: async () => {
        calls += 1;
        return Promise.reject(new CertifyFailedError("timeout", "too slow"));
      },
    };
    const { journal, made, candidate, status } = await workbench(down);
    await candidate();
    await assert.rejects(made.certify(), /too slow/);
    await assert.rejects(made.certify(), /too slow/);
    assert.equal(calls, 1);
    assert.equal(made.awaitsCertification, false);
    assert.equal(status(), "computed");
    assert.deepEqual(journal.projection.validations("clm_a").map((v) => v.method), ["repl"]);
    journal.close();
  });

  it("settles a claim that was only proved informally", async () => {
    const { certifier: certified } = certifier();
    const { journal, made, candidate, status } = await workbench(certified);
    journal.emit("claim.status_changed", { claimId: "clm_a", from: "open", to: "proved_informal", reason: "a person read the proof" }, "test");
    await candidate();
    assert.equal(status(), "proved_informal", "a fast check does not move a claim that is not open");
    assert.equal((await made.certify())?.status, "proved");
    assert.equal(status(), "proved");
    journal.close();
  });
});
