import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { check, demoAnswer, proofOf, say } from "./m0-helpers.ts";
import { sessionPromptOf } from "./resume-helpers.ts";
import type { FakeLeanAnswer } from "../../core/test/fake-lean.ts";

/** The simulated Lean of the M18 tests: `exact var_ok` proves a variant, `exact fun h => h` the link lemma of a special-case edge; anything else is the demo's. */
export function m18Answer(code: string): FakeLeanAnswer {
  const proof = proofOf(code);
  if (proof === undefined) return {};
  if (proof.includes("var_ok") || proof.trim() === "exact fun h => h") return {};
  return demoAnswer(code);
}

export const SMALL = ": 3 + 0 = 3";
export const HYPOTHESIS = "(n : ℕ) (h : 0 < n) : n + 0 = n";
export const PRIME = "(p : ℕ) (hp : p.Prime) : p + 0 = p";

/** The model's answer to the request for variants. */
export const variants = (...items: Array<[string, string]>) => say(JSON.stringify({ variants: items.map(([kind, statement]) => ({ kind, statement })) }));

/** The model's answer to an inner session: a proof. */
export const proves = (proof: string) => say(JSON.stringify({ proof }));

/**
 * A model that answers by what it is asked, whatever the order of the calls: the variants for the request for them, a proof
 * for an inner session, and for the outer prover a bad check and then its notes. `count` answers are available.
 */
export function responder(count = 40): FauxResponseStep[] {
  const step: FauxResponseStep = (context) => {
    const prompt = sessionPromptOf(context);
    if (prompt.includes("preparing easier variants")) return variants(["small_case", SMALL], ["extra_hypothesis", HYPOTHESIS]);
    if (prompt.includes("proving an easier variant")) return proves("exact var_ok");
    return context.messages.some((m) => m.role === "assistant") ? say("notes") : check("bad");
  };
  return Array.from({ length: count }, () => step);
}
