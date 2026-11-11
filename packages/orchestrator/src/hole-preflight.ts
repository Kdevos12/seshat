import { DEFAULT_SETTINGS, NO_EXTRA_TACTICS, randomFor, solveGoal } from "@seshat/classical";
import { closedProp, parseSignature } from "@seshat/graph";
import type { HolePreflightRequest, HolePreflightResult, ValidateRequest, ValidateResult } from "@seshat/lines";
import { plausibleTest, recordHygiene } from "@seshat/lit";
import type { MemoryStore } from "@seshat/memory";
import { RegistryLeanChecker, type Registry } from "@seshat/registry";

export interface HolePreflightDeps {
  registry: Registry;
  memory: MemoryStore;
  validate: (request: ValidateRequest) => Promise<ValidateResult>;
  signal: AbortSignal;
  log: (text: string) => void;
  seed?: string | number;
  actor: string;
  /** The header of the problem's file, for a claim that has none of its own. */
  header: string;
}

/** The Lean seconds each battery of the pre-flight may use. The tests are cheap: they are there so that no paid session is spent on a hole a tactic closes or a negation a tactic proves. */
const BATTERY_SEC = 30;

/**
 * The pre-flight of a hole (plan change CA11), before any paid session and at no model cost: the battery of line M10 on the hole (its core
 * tactics: the host's optional tactics are not probed again here), `plausible` through Task 36's hygiene test (recorded as a `hygiene` evidence
 * node), and a short attempt of the battery on the hole's negation. A proof the battery finds goes through `validate`, with the negation flag for
 * the negation: that is the only way the pre-flight changes anything. M11's small models are not asked: see documentation/scheduler.md, "Pre-flight".
 */
export async function holePreflight(d: HolePreflightDeps, request: HolePreflightRequest): Promise<HolePreflightResult> {
  const claim = d.memory.claim(request.claimId);
  const notes: string[] = [];
  if (claim === undefined || claim.kind !== "formal") return { proved: false, refuted: false, notes: ["the claim is not a formal statement"] };
  const header = claim.header ?? d.header;
  const checker = new RegistryLeanChecker(d.registry, { actor: d.actor });
  const settings = { ...DEFAULT_SETTINGS, cpuBudgetSec: BATTERY_SEC, maxSubmissions: 1 };
  const context = (validate: (request: ValidateRequest) => Promise<ValidateResult>, salt: string) => ({
    checker, memory: d.memory, validate, host: NO_EXTRA_TACTICS, settings, random: randomFor(d.seed, `${request.claimId}:${salt}`), signal: d.signal, log: d.log,
  });

  const forward = await solveGoal(context(d.validate, "preflight"), { claimId: request.claimId, header, statement: claim.statement });
  if (forward.settled) return { proved: true, refuted: false, notes: [`the battery proved the hole with ${forward.winner?.tactic ?? "a tactic"}`] };
  notes.push(`the battery did not close the hole (${forward.tries.length} tries)`);

  let plausible: string | undefined;
  if (!d.signal.aborted) {
    const found = await plausibleTest(checker, header, claim.statement, { signal: d.signal });
    plausible = found.result;
    recordHygiene(d.memory, request.claimId, found);
    notes.push(`plausible: ${found.result}${found.detail !== undefined ? ` (${found.detail})` : ""}`);
  }

  let refuted = false;
  if (!d.signal.aborted) {
    try {
      const negation = `: ¬ (${closedProp(parseSignature(claim.statement))})`;
      const out = await solveGoal(
        context((r) => d.validate({ ...r, negation: true }), "negation"),
        { claimId: request.claimId, header, statement: negation },
      );
      refuted = out.settled;
      notes.push(refuted ? `the battery proved the negation with ${out.winner?.tactic ?? "a tactic"}` : "the battery did not prove the negation");
    } catch (error) {
      notes.push(`the negation was not tried: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { proved: false, refuted, ...(plausible !== undefined ? { plausible } : {}), notes };
}
