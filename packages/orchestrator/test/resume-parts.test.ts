import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import {
  BlobStore,
  type CertificationResult,
  type LeanCertifier,
  Journal,
  prepareSketch,
  ProofValidator,
  readEvents,
  SKETCH_POLICY,
  toPlainHeader,
} from "@seshat/core";
import { RegistryLeanChecker } from "@seshat/registry";
import { Ledger, resolveModel, runProver, Workbench } from "../src/index.ts";
import { check, DEMO_FILE, DemoLean, demoRegistry, fauxModels, ofType, say, tempDir } from "./m0-helpers.ts";

/** A certifier that answers `verdict` to every request, and keeps how often it was asked. */
function certifier(verdict: "certified" | "rejected" = "certified") {
  const requests: string[] = [];
  const made: LeanCertifier = {
    implementation: "fake-certifier",
    version: "0",
    certify: async (request): Promise<CertificationResult> => {
      requests.push(request.candidate);
      return { verdict, reasons: verdict === "certified" ? [] : ["kernel: declaration has metavariables"], axioms: ["propext"], timeMs: 1 };
    },
  };
  return { requests, certifier: made };
}

/** The journal, blobs and registry of a run that has a claim for the demo problem; `make` builds workbenches on them, as the processes of a run would. */
async function inRun() {
  const dir = tempDir();
  const journal = Journal.open(dir, "run_test");
  const blobs = new BlobStore(join(dir, "blobs"));
  const registry = demoRegistry(new DemoLean())(journal, blobs);
  const source = toPlainHeader(DEMO_FILE);
  const sketch = prepareSketch(source, "Demo.add_zero'");
  const reference = await new ProofValidator(new RegistryLeanChecker(registry), { policy: SKETCH_POLICY }).reference(sketch, source);
  const statement = "(n : ℕ) : n + 0 = n";
  journal.emit("claim.created", { claimId: "clm_a", statementId: `st9:${statement}`, statement, origin: "test", status: "open" }, "test");
  const make = (certifier?: LeanCertifier) =>
    new Workbench({ journal, registry, problem: { source, sketch }, claimId: "clm_a", reference, blobs, ...(certifier !== undefined ? { certifier } : {}) });
  return {
    dir,
    journal,
    blobs,
    registry,
    source,
    sketch,
    reference,
    make,
    status: () => journal.projection.claim("clm_a")?.status,
    events: () => readEvents(join(dir, "journal.jsonl")),
    kernelReplays: () => journal.projection.validations("clm_a").filter((v) => v.method === "kernel_replay"),
  };
}

const PROOF = { aux: "", proof: "exact trivial_proof" };

describe("Ledger.seed", () => {
  const spent = { usd: 2, inputTokens: 100, outputTokens: 50, requests: 3 };

  it("sets what a ledger has spent, without charging the ledgers above it", () => {
    const run = new Ledger(10);
    const problem = run.child(5);
    problem.seed(spent);
    assert.deepEqual([problem.usd, problem.inputTokens, problem.outputTokens, problem.requests], [2, 100, 50, 3]);
    assert.equal(run.usd, 0, "each ledger is seeded from the journal's account of it");
    problem.charge({ usd: 1, inputTokens: 10, outputTokens: 5 });
    assert.deepEqual([problem.usd, problem.requests, run.usd], [3, 4, 1]);
  });

  it("is exhausted at once when the spend reaches the limit, and tells the listeners, late ones too", () => {
    const problem = new Ledger(10).child(2);
    const told: string[] = [];
    problem.onExhausted(() => told.push("early"));
    problem.seed(spent);
    assert.equal(problem.exhausted, true);
    assert.deepEqual(told, ["early"]);
    problem.onExhausted(() => told.push("late"));
    assert.deepEqual(told, ["early", "late"]);
  });

  it("exhausts the problems below a run whose spend reached its limit", () => {
    const run = new Ledger(2);
    run.seed(spent);
    const problem = run.child(5);
    assert.equal(problem.exhausted, true);
    let told = false;
    problem.onExhausted(() => {
      told = true;
    });
    assert.equal(told, true);
  });

  it("leaves a ledger with room, or without a limit, working", () => {
    const room = new Ledger(10);
    room.seed(spent);
    assert.equal(room.exhausted, false);
    const free = new Ledger();
    free.seed({ usd: 1e9, inputTokens: 0, outputTokens: 0, requests: 1 });
    assert.equal(free.exhausted, false);
  });
});

describe("Workbench.adopt", () => {
  it("gives a workbench the candidate of a run that was interrupted, which the next certify certifies once", async () => {
    const run = await inRun();
    const first = run.make();
    assert.equal((await first.check(PROOF, { actor: "test" })).accepted, true);
    const candidate = first.candidate;
    assert.ok(candidate !== undefined);

    const { certifier: counted, requests } = certifier();
    const resumed = run.make(counted);
    let heard = 0;
    resumed.onCandidate(() => {
      heard += 1;
    });
    resumed.adopt(candidate);
    assert.equal(heard, 1, "the listeners of the problem are told, as for a candidate found now");
    assert.equal(resumed.candidate, candidate);
    assert.equal(resumed.awaitsCertification, true);
    assert.throws(() => resumed.adopt(candidate), /already has a candidate/);

    const [one, two] = await Promise.all([resumed.certify(), resumed.certify()]);
    assert.equal(one, two);
    assert.deepEqual([one?.result.verdict, one?.status, run.status(), requests.length], ["certified", "proved", "proved", 1]);
    run.journal.close();
  });

  it("does not certify a candidate again when the journal holds the certifier's answer", async () => {
    const run = await inRun();
    const { certifier: firstCertifier, requests: firstRequests } = certifier();
    const first = run.make(firstCertifier);
    await first.check(PROOF, { actor: "test" });
    assert.equal((await first.certify())?.status, "proved");
    assert.equal(firstRequests.length, 1);
    const [answer] = run.kernelReplays();
    assert.ok(answer !== undefined);

    const { certifier: secondCertifier, requests } = certifier();
    const resumed = run.make(secondCertifier);
    resumed.adopt(first.candidate as NonNullable<typeof first.candidate>, {
      validationId: answer.validation_id,
      verdict: "valid",
      reasons: answer.reasons,
      axioms: answer.axioms,
    });
    assert.equal(resumed.awaitsCertification, false, "nothing is left to certify");
    const done = await resumed.certify();
    assert.equal(requests.length, 0, "the certifier was not asked");
    assert.deepEqual([done?.validationId, done?.result.verdict, done?.status], [answer.validation_id, "certified", "proved"]);
    assert.equal(run.kernelReplays().length, 1, "no second kernel_replay validation");
    run.journal.close();
  });

  it("keeps a rejection too: not asked again, and the claim stays a candidate", async () => {
    const run = await inRun();
    const first = run.make(certifier("rejected").certifier);
    await first.check(PROOF, { actor: "test" });
    assert.equal((await first.certify())?.result.verdict, "rejected");
    const [answer] = run.kernelReplays();
    assert.ok(answer !== undefined);
    assert.equal(answer.verdict, "invalid");

    const { certifier: second, requests } = certifier();
    const resumed = run.make(second);
    resumed.adopt(first.candidate as NonNullable<typeof first.candidate>, {
      validationId: answer.validation_id,
      verdict: "invalid",
      reasons: answer.reasons,
      axioms: answer.axioms,
    });
    const done = await resumed.certify();
    assert.deepEqual([done?.result.verdict, done?.result.reasons, done?.status, requests.length], [
      "rejected",
      ["kernel: declaration has metavariables"],
      "computed",
      0,
    ]);
    run.journal.close();
  });

  it("finishes the move to proved that the interruption cut after the certifier's answer", async () => {
    const run = await inRun();
    const first = run.make();
    await first.check(PROOF, { actor: "test" });
    const candidate = first.candidate as NonNullable<typeof first.candidate>;
    // The answer was written, and the process ended before the claim became proved.
    run.journal.emit(
      "validation.finished",
      {
        validationId: "val_cut", claimId: "clm_a", method: "kernel_replay", verdict: "valid", reasons: [], axioms: ["propext"],
        submissionHash: candidate.report.submissionHash,
      },
      "fake-certifier",
    );
    assert.equal(run.status(), "computed");

    const { certifier: asked, requests } = certifier();
    const resumed = run.make(asked);
    resumed.adopt(candidate, { validationId: "val_cut", verdict: "valid", reasons: [], axioms: ["propext"] });
    assert.equal(run.status(), "proved");
    const change = ofType(run.events(), "claim.status_changed").at(-1);
    assert.deepEqual([change?.data.from, change?.data.to, change?.data.validationId], ["computed", "proved", "val_cut"]);
    assert.equal((await resumed.certify())?.status, "proved");
    assert.equal(requests.length, 0);
    run.journal.close();
  });

  it("makes the claim a candidate when the interruption cut the change of status after the fast check", async () => {
    const run = await inRun();
    const report = await new ProofValidator(new RegistryLeanChecker(run.registry), { policy: SKETCH_POLICY }).validate(
      run.sketch,
      run.make().render(PROOF),
      run.reference,
    );
    assert.equal(report.verdict, "valid");
    run.journal.emit(
      "validation.finished",
      {
        validationId: "val_fast", claimId: "clm_a", method: "repl", verdict: "valid", reasons: [], axioms: report.axioms,
        submissionHash: report.submissionHash,
      },
      "validator",
    );
    assert.equal(run.status(), "open", "the fast check was recorded, its status was not");

    run.make().adopt({ validationId: "val_fast", report });
    assert.equal(run.status(), "computed");
    const change = ofType(run.events(), "claim.status_changed").at(-1);
    assert.deepEqual([change?.data.from, change?.data.to, change?.data.validationId, change?.actor], ["open", "computed", "val_fast", "orchestrator"]);
    run.journal.close();
  });
});

type Message = TranscriptContext["messages"][number];

/** The text of the first user message of a request: the session prompt. */
function sessionPromptOf(context: TranscriptContext): string {
  const first: Message | undefined = context.messages.find((m) => m.role === "user");
  if (first?.role !== "user") return "";
  return typeof first.content === "string" ? first.content : first.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

describe("a prover that resumes", () => {
  async function prover(run: Awaited<ReturnType<typeof inRun>>, sessions: number, extra: Partial<Parameters<typeof runProver>[0]> = {}) {
    const { models, faux, name } = fauxModels();
    const options = {
      name: "p1",
      workbench: run.make(),
      journal: run.journal,
      blobs: run.blobs,
      models,
      model: await resolveModel(models, name),
      modelName: name,
      thinkingLevel: "off" as const,
      sessions,
      limits: { turns: 5, contextTokens: 100_000 },
      notesChars: 1000,
      ledger: new Ledger(5),
      signal: new AbortController().signal,
      ...extra,
    };
    return { faux, options };
  }

  it("starts at the session after the last one, from the file, the last check and the notes it carried", async () => {
    const run = await inRun();
    const { faux, options } = await prover(run, 3, {
      resume: { session: 1, attempts: 1, failed: 0, carry: { regions: { aux: "", proof: "exact earlier_idea" }, lastCheck: "Lean: unknown identifier 'earlier_idea'", notes: "NOTES: try the other lemma." } },
    });
    const prompts: string[] = [];
    faux.setResponses([(context) => { prompts.push(sessionPromptOf(context)); return check("exact trivial_proof"); }]);
    const result = await runProver(options);
    assert.deepEqual(result, { name: "p1", attempts: 2, stop: "solved" });
    const [started] = ofType(run.events(), "attempt.started");
    assert.equal(started?.data.iteration, 2);
    const prompt = prompts[0] ?? "";
    assert.match(prompt, /This is session 2 of at most 3\./);
    assert.match(prompt, /NOTES: try the other lemma\./);
    assert.match(prompt, /exact earlier_idea/);
    assert.match(prompt, /unknown identifier 'earlier_idea'/);
    run.journal.close();
  });

  it("starts from the file as it was given when nothing was carried, and uses only the sessions that are left", async () => {
    const run = await inRun();
    const { faux, options } = await prover(run, 3, { resume: { session: 2, attempts: 2, failed: 0 } });
    const prompts: string[] = [];
    faux.setResponses([check("bad"), (context) => { prompts.push(sessionPromptOf(context)); return say("NOTES: still no."); }]);
    const result = await runProver(options);
    assert.deepEqual(result, { name: "p1", attempts: 3, stop: "sessions" });
    assert.deepEqual(ofType(run.events(), "attempt.started").map((a) => a.data.iteration), [3], "one session was left");
    run.journal.close();
  });

  it("counts the sessions in a row that failed before the interruption", async () => {
    const run = await inRun();
    const failing = async (failed: number) => {
      const { faux, options } = await prover(run, 6, { resume: { session: 1, attempts: 1, failed } });
      // A check that throws is a failure of the harness, which ends the session with an error.
      options.workbench.check = async () => { throw new Error("boom"); };
      faux.setResponses([check("bad"), check("bad"), check("bad"), check("bad"), check("bad")]);
      return await runProver(options);
    };
    // One failed session before the interruption and one now: the prover has failed twice in a row and stops.
    assert.deepEqual(await failing(1), { name: "p1", attempts: 2, stop: "errors" });
    // Without the earlier failure it takes two sessions now.
    assert.deepEqual(await failing(0), { name: "p1", attempts: 3, stop: "errors" });
    run.journal.close();
  });
});

describe("a session that the harness fails in", () => {
  it("ends at the cost it was charged before it failed, so that what it spent stays counted", async () => {
    const run = await inRun();
    const { options } = await (async () => {
      const { models, name } = fauxModels();
      return {
        options: {
          name: "p1",
          workbench: run.make(),
          journal: run.journal,
          blobs: run.blobs,
          models,
          model: await resolveModel(models, name),
          modelName: name,
          thinkingLevel: "off" as const,
          sessions: 2,
          limits: { turns: 5, contextTokens: 100_000 },
          notesChars: 1000,
          ledger: new Ledger(5),
          signal: new AbortController().signal,
          // A session that is charged for two responses and then fails, as a harness bug in the middle of one would.
          session: async (session: Parameters<NonNullable<Parameters<typeof runProver>[0]["session"]>>[0]): Promise<never> => {
            for (const usd of [0.5, 0.25]) {
              const cost = { usd, inputTokens: 100, outputTokens: 10 };
              session.ledger.charge(cost);
              session.onCharge?.(cost);
            }
            throw new Error("the harness broke");
          },
        },
      };
    })();
    assert.equal(run.journal.projection.totalSpend().usd, 0);
    await assert.rejects(runProver(options), /the harness broke/);
    const [started] = ofType(run.events(), "attempt.started");
    const finished = ofType(run.events(), "attempt.finished");
    assert.equal(finished.length, 1);
    assert.deepEqual(
      [finished[0]?.data.attemptId, finished[0]?.data.outcome, finished[0]?.data.stoppedBy, finished[0]?.data.turns, finished[0]?.data.usd, finished[0]?.data.inputTokens, finished[0]?.data.outputTokens],
      [started?.data.attemptId, "error", "error", 2, 0.75, 200, 20],
      "the attempt ends at the sum of its charges",
    );
    // The journal's account is what a resumed run seeds its budgets from, and what the report adds up.
    const total = run.journal.projection.totalSpend();
    assert.deepEqual([total.usd, total.requests, total.inputTokens, total.outputTokens], [0.75, 2, 200, 20]);
    assert.equal(options.ledger.usd, 0.75, "the run's ledger and the journal agree");
    assert.equal(run.journal.projection.spendBySite().find((s) => s.site === "prover.session")?.usd, 0.75);
    run.journal.close();
  });
});
