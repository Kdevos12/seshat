import { canonicalJson, collapseWhitespace, type Json, sha256Hex, stripLeanComments } from "@seshat/core";
import { type ImplementationFactory, type ImplementationInstance, UnavailableError } from "@seshat/registry";
import type { LeanMetaInput, LeanMetaOutput } from "./meta.ts";

/** One answer of the simulated `lean.meta`. */
export interface SimulatedEntry {
  /** The input fields this entry answers: it matches an input that has each of them, equal. */
  input: Record<string, Json>;
  /** The answer, or else a refusal (`error`: Lean's message) or no answer (`unavailable`). */
  output?: LeanMetaOutput;
  error?: string;
  unavailable?: string;
}

/**
 * A `lean.meta` without Lean, for tests and dry runs: the answers come from a table. The first entry
 * whose fields match answers; a `hash` that no entry answers gets `simulatedId` of its text, and any
 * other call that no entry answers is refused. Two statements are the same claim only through the
 * table, which says which texts Lean would elaborate to the same term.
 */
export class SimulatedLeanMeta {
  readonly entries: SimulatedEntry[];
  /** Every input received, in order. */
  readonly calls: LeanMetaInput[] = [];

  constructor(entries: readonly SimulatedEntry[] = []) {
    this.entries = [...entries];
  }

  answer(input: LeanMetaInput): LeanMetaOutput {
    this.calls.push(input);
    const fields = input as unknown as Record<string, Json>;
    const entry = this.entries.find((e) => Object.entries(e.input).every(([k, v]) => k in fields && canonicalJson(fields[k]) === canonicalJson(v)));
    if (entry !== undefined) {
      if (entry.unavailable !== undefined) throw new UnavailableError(entry.unavailable);
      if (entry.error !== undefined) throw new Error(entry.error);
      return entry.output ?? {};
    }
    if (input.op === "hash") return { id: simulatedId(input.statement) };
    throw new Error(`the simulated lean.meta has no answer for ${canonicalJson(input)}`);
  }

  implementation(): ImplementationInstance {
    return {
      invoke: async (input) => this.answer(input as unknown as LeanMetaInput) as unknown as Json,
      health: async () => ({ ok: true, detail: `simulated, ${this.entries.length} answer(s)` }),
    };
  }

  /** A registry factory that serves this table, whatever the implementation's settings. */
  factory(): ImplementationFactory {
    return () => this.implementation();
  }
}

/** The simulated id of a statement: `st1_` and a hash of its text without comments, whitespace collapsed. */
export function simulatedId(statement: string): string {
  return `st1_${sha256Hex(`simulated lean.meta\n${collapseWhitespace(stripLeanComments(statement))}`).slice(0, 32)}`;
}
