/**
 * @seshat/guards: the guards against hallucination and the drift detectors (line M6, plan §9),
 * documented in documentation/guards.md. Every finding is a `drift` node of the memory; no guard
 * changes a claim's status.
 */
export * from "./citations.ts";
export * from "./detectors.ts";
export * from "./drift.ts";
export * from "./framing.ts";
export * from "./m6.ts";
export * from "./rawerrors.ts";
export * from "./revisions.ts";
export { auxDeclarations, codeSize, hasHole, leanComments, leanPassages, normalizeSubmission, type AuxDeclaration, type LeanComment } from "./text.ts";
