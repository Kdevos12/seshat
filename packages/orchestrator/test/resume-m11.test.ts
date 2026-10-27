import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CertificationRequest, CertificationResult, HarnessEvent, LeanCertifier, LeanCheckOptions, LeanCheckResult, LeanChecker, LeanSnippet } from "@seshat/core";
import { type CounterModel, negationProofs, recognizeStatement } from "@seshat/models";
import { type Instance, SimulatedDecide } from "../../models/test/simulated-lean.ts";
import { check, DemoLean, demoAnswer, demoResume, demoRun, killedAt, ofType, proofOf } from "./m0-helpers.ts";
import { assertSound } from "./resume-helpers.ts";

/**
 * Line M11 in a resumed run, cut at every event of its journal. The line is `stateless`: everything it
 * keeps is in the memory (the fingerprint, the counter-model and what became of its refutation, the
 * identification), and its hook skips what the memory shows done. The Lean here is simulated.
 */
const MAGMAS = `import FormalConjectures.Util.ProblemImports

namespace Magmas

/-- A magma whose product is the left projection is commutative. False: it has two elements. -/
@[category research solved, AMS 8]
theorem left_proj_comm (M : Type*) [Mul M] (h : ∀ x y : M, x * y = x) : ∀ x y : M, x * y = y * x := by
  sorry

end Magmas
`;
const NUMBERS = `import FormalConjectures.Util.ProblemImports

namespace Magmas

/-- An even number is below fifty. False: fifty. -/
@[category research solved, AMS 11]
theorem even_below_fifty (n : ℕ) (h : n % 2 = 0) : n < 50 := by
  sorry

end Magmas
`;
const LEFT_PROJECTION_COMMUTES = "(M : Type*) [Mul M] (h : ∀ x y : M, x * y = x) : ∀ x y : M, x * y = y * x";
const EVEN_BELOW_FIFTY = "(n : ℕ) (h : n % 2 = 0) : n < 50";

const normalize = (text: string) => text.split("\n").map((l) => l.trim()).filter((l) => l !== "").join("\n");

function firstProof(statement: string, object: CounterModel): string {
  const recognized = recognizeStatement(statement);
  assert.ok("statement" in recognized);
  const proof = negationProofs(recognized.statement, object)[0];
  assert.ok(proof !== undefined);
  return proof.proof;
}

/** The evaluator's `decide` files are answered from the statement's meaning, the validator's by the demo Lean for the proofs it is told are right. */
class MixedLean implements LeanChecker {
  readonly implementation = "mixed-lean";
  readonly version = "0";
  readonly decide: SimulatedDecide;
  private readonly demo: DemoLean;
  constructor(truth: (instance: Instance) => boolean | undefined, accepted: readonly string[]) {
    this.decide = new SimulatedDecide({ truth });
    const right = new Set(accepted.map(normalize));
    this.demo = new DemoLean((code) => {
      const proof = proofOf(code);
      return proof !== undefined && right.has(normalize(proof)) ? {} : demoAnswer(code);
    });
  }
  async check(snippets: readonly LeanSnippet[], options: LeanCheckOptions = {}): Promise<LeanCheckResult[]> {
    return Promise.all(
      snippets.map(async (snippet) => {
        const [result] = await (snippet.code.includes("m11_stmt") ? this.decide : this.demo).check([snippet], options);
        return result as LeanCheckResult;
      }),
    );
  }
}

function countingCertifier(): { requests: CertificationRequest[]; certifier: LeanCertifier } {
  const requests: CertificationRequest[] = [];
  return {
    requests,
    certifier: {
      implementation: "fake-certifier",
      version: "0",
      certify: async (request): Promise<CertificationResult> => {
        requests.push(request);
        return { verdict: "certified", reasons: [], axioms: ["propext"], timeMs: 1 };
      },
    },
  };
}

const nodesOf = (events: readonly HarnessEvent[], kind: string) => ofType(events, "node.recorded").filter((n) => n.data.kind === kind);
const kernelReplays = (events: readonly HarnessEvent[]) => ofType(events, "validation.finished").filter((v) => v.data.method === "kernel_replay");

describe("line M11 in a resumed run", () => {
  const magmaProof = firstProof(LEFT_PROJECTION_COMMUTES, { kind: "magma", id: "2:0011", size: 2, table: [0, 0, 1, 1] });
  const numberProof = firstProof(EVEN_BELOW_FIFTY, { kind: "integer", id: "50", value: 50 });

  it("resumes a certified refutation cut at every event: refuted, certified once, the counter-model recorded once", async () => {
    const config = { lines: ["M11"], sessions: 1 };
    const first = countingCertifier();
    const whole = await demoRun({ file: MAGMAS, config, lean: new MixedLean(() => true, [magmaProof]), certifier: first.certifier, responses: [check("exact trivial_proof")] });
    assert.equal(whole.result.problems[0]?.outcome, "refuted");
    assert.equal(kernelReplays(whole.events).length, 1);
    for (let cut = 1; cut < whole.events.length; cut++) {
      const where = `cut after ${cut} of ${whole.events.length} events (${whole.events[cut - 1]?.type})`;
      const again = countingCertifier();
      const resumed = await demoResume({
        dir: killedAt(whole.dir, cut),
        bench: whole.bench,
        lean: new MixedLean(() => true, [magmaProof]),
        certifier: again.certifier,
        responses: [check("exact trivial_proof")],
      });
      assert.equal(resumed.result.problems[0]?.outcome, "refuted", `${where}: ${resumed.result.problems[0]?.reason}`);
      assert.equal(kernelReplays(resumed.events).length, 1, `${where}: one certification on record`);
      assert.equal(again.requests.length, 1 - kernelReplays(whole.events.slice(0, cut)).length, `${where}: the certifier was asked only for what was missing`);
      assert.equal(nodesOf(resumed.events, "counter_model").length, 1, `${where}: the counter-model is recorded once`);
      assert.equal(nodesOf(resumed.events, "fingerprint").length, 1, `${where}: one fingerprint`);
      assert.equal(ofType(resumed.events, "edge.added").filter((e) => e.data.kind === "refuted_by").length, 1, `${where}: one refuted_by edge`);
      assert.equal(ofType(resumed.events, "attempt.started").length, 0, `${where}: the provers never ran`);
      assertSound(resumed.events);
    }
  });

  it("resumes a statement about a number cut at every event, and does not send the evaluator's files to Lean again once the fingerprint is recorded", async () => {
    const truth = (i: Instance) => (i.kind === "nat" ? i.value % 2 !== 0 || i.value < 50 : undefined);
    const config = { lines: ["M11"], sessions: 1 };
    const whole = await demoRun({ file: NUMBERS, config, lean: new MixedLean(truth, [numberProof]), responses: [check("exact trivial_proof")] });
    assert.equal(nodesOf(whole.events, "identification").length, 1);
    const fingerprinted = whole.events.findIndex((e) => e.type === "node.recorded" && e.data.kind === "fingerprint") + 1;
    assert.ok(fingerprinted > 0);
    for (let cut = 1; cut < whole.events.length; cut++) {
      const where = `cut after ${cut} of ${whole.events.length} events (${whole.events[cut - 1]?.type})`;
      const lean = new MixedLean(truth, [numberProof]);
      const resumed = await demoResume({ dir: killedAt(whole.dir, cut), bench: whole.bench, lean, responses: [check("exact trivial_proof")] });
      assert.equal(resumed.result.problems[0]?.outcome, "unsolved", `${where}: ${resumed.result.problems[0]?.reason}`);
      assert.equal(nodesOf(resumed.events, "counter_model").length, 1, `${where}: the counter-model is recorded once`);
      assert.equal(nodesOf(resumed.events, "identification").length, 1, `${where}: the sequence is recorded once`);
      assert.equal(nodesOf(resumed.events, "fingerprint").length, 1, `${where}: one fingerprint`);
      assert.ok(ofType(resumed.events, "validation.finished").filter((v) => v.data.negation === true && v.data.method === "repl").length <= 2, `${where}: the negation is not checked over and over`);
      if (cut >= fingerprinted) assert.equal(lean.decide.calls.length, 0, `${where}: the evaluator's files are not sent again`);
      assertSound(resumed.events);
    }
  });
});
