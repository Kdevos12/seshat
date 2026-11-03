import type { LeanChecker } from "@seshat/core";
import { type HostTactics, isUnknownTactic, probeSnippet, TACTICS } from "./tactics.ts";

const IMPORT_FAILURE = /unknown module prefix|bad import|object file .* does not exist|unknown package|failed to read file|invalid import/iu;

/** What a probe of the host's Lean found. */
export interface HostProbe extends HostTactics {
  /** The `needs` that were asked about and found missing. */
  missing: string[];
  /** Set when Lean could not be asked at all: nothing was learned, and the host is taken to have nothing extra. */
  unreachable?: string;
}

/**
 * Asks the host's Lean which of the optional tactics it has, by elaborating `example : 0 = 0 := by
 * <tactic>` for each: a parse error ("unknown tactic", "expected ...") says the syntax is not there,
 * and any other answer (success, or a tactic that fails on this goal) says it is. The battery's
 * tactic list is read this way and never assumed, `polyrith` included: whether Mathlib still has it
 * is the host's answer. `known` names `needs` to take as present without asking (a host-profile option).
 */
export async function probeHost(checker: LeanChecker, options: { header?: string; known?: readonly string[]; signal?: AbortSignal; timeoutSec?: number } = {}): Promise<HostProbe> {
  const have = new Set<string>(options.known ?? []);
  const missing: string[] = [];
  const asked = TACTICS.filter((t) => t.needs !== undefined && !have.has(t.needs));
  const results = await checker.check(
    asked.map((t) => ({ id: `m10-probe:${t.name}`, code: probeSnippet(options.header ?? "import Mathlib", t.script) })),
    { timeoutSec: options.timeoutSec ?? 60, ...(options.signal !== undefined ? { signal: options.signal } : {}) },
  );
  let unreachable: string | undefined;
  asked.forEach((t, i) => {
    const r = results[i];
    const needs = t.needs as string;
    if (r === undefined || r.status === "server_error" || r.status === "repl_error" || r.status === "timeout" || r.messages.some((m) => m.severity === "error" && IMPORT_FAILURE.test(m.text))) {
      // Nothing was learned about the tactic: a timeout or a failed import says nothing about its syntax.
      unreachable = r?.error ?? (r?.status === "timeout" ? "the probe timed out" : r === undefined ? "Lean did not answer" : (r.messages.find((m) => IMPORT_FAILURE.test(m.text))?.text ?? "Lean could not elaborate the probe").slice(0, 200));
    } else if (isUnknownTactic(r)) {
      if (!missing.includes(needs)) missing.push(needs);
    } else {
      have.add(needs);
    }
  });
  // `needs` shared by several tactics: present when any of them parsed.
  const stillMissing = missing.filter((m) => !have.has(m));
  return { have, missing: stillMissing, ...(unreachable !== undefined ? { unreachable } : {}) };
}
