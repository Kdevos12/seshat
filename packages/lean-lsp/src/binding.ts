import type { Json, Sketch, Submission } from "@seshat/core";
import { FILE_OPS, type Op } from "./protocol.ts";
import { presentOutput } from "./present.ts";

/**
 * How a run gives `lean.lsp` to a prover: the problem's sketch is the harness's to fill in, so the
 * tool's parameters do not show it and a prover cannot set it; the regions default to the last that
 * the prover checked; and the answer is written for the prover to read. The orchestrator's
 * `ToolBinding` has this shape.
 */
export interface LeanLspBinding {
  /** Input fields that the harness fills in: removed from the parameters the prover sees. */
  readonly hidden: readonly string[];
  /** The input of the registry call, from the arguments of the prover's call. */
  bind(params: Record<string, Json>): Record<string, Json>;
  /** The answer as the prover reads it. */
  present(output: Json): string;
}

export interface LeanLspBindingOptions {
  /** The sketch of the problem the prover works on. */
  sketch: Sketch;
  /** The regions of the prover's last `lean_check`, or those it started the session with. */
  current: () => Submission;
}

export function leanLspBinding(o: LeanLspBindingOptions): LeanLspBinding {
  return {
    hidden: ["sketch"],
    bind(params) {
      // Whatever the prover put in a hidden field is dropped, not used.
      const { sketch: _dropped, ...rest } = params;
      if (typeof rest.op !== "string" || !FILE_OPS.includes(rest.op as Op)) return rest;
      const current = o.current();
      return {
        ...rest,
        sketch: o.sketch as unknown as Json,
        aux: rest.aux ?? current.aux,
        proof: rest.proof ?? current.proof,
      };
    },
    present: presentOutput,
  };
}
