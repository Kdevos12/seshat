import { collapseWhitespace, maskCommentsAndStrings, prepareSketch, readDeclarationHead, splitCommands, type Submission, type ValidationReport } from "@seshat/core";

/** A hole's declared dependency as its session sees it: the name and the statement, to be a stub. */
export interface Dependency {
  name: string;
  /** The statement in signature form. */
  statement: string;
}

const HOLE_TOKEN = /(?<![\p{L}\p{N}_'.!?])(?:sorry|admit)(?![\p{L}\p{N}_'!?])/u;

/** True when the text (comments and strings aside) has a `sorry` or an `admit`. */
export const hasHole = (text: string): boolean => HOLE_TOKEN.test(maskCommentsAndStrings(text));

/** The stub of a dependency: its statement, proved by `sorry`. The hole's session may use it by name and may not change it. */
export const stubOf = (dep: Dependency): string => `lemma ${dep.name} ${dep.statement.trim()} := by\n  sorry`;

/** The aux region a hole session starts from: the stubs of the dependencies, and nothing else. */
export const stubsRegion = (deps: readonly Dependency[]): string => deps.map(stubOf).join("\n\n");

export interface WorkReading {
  /** The work on the hole is done (CA10): no Lean error, and every `sorry` lies in a dependency stub. */
  done: boolean;
  /** Why not, when it is not. */
  reason?: string;
  /** The aux region without the stubs: the helper lemmas the proof uses, as written. */
  helpers: string;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when the text (comments and strings aside) names the dependency as an identifier. */
const mentions = (text: string, name: string): boolean =>
  new RegExp(`(?<![\\p{L}\\p{N}_'.!?])${escapeRegExp(name)}(?![\\p{L}\\p{N}_'!?])`, "u").test(maskCommentsAndStrings(text));

const same = (a: string, b: string): boolean => collapseWhitespace(a) === collapseWhitespace(b);

/**
 * The line's rule for when a hole's work is done: Lean reported no error on the small file, nothing was changed outside the regions, a
 * dependency's stub that is in the file is exactly the dependency's statement with the proof `sorry`, and the rest of the file (the helper
 * lemmas and the hole's own proof) has no `sorry` or `admit`. So every `sorry` Lean reports lies in a stub. It is a fact about a file and
 * not a status: the claim becomes `computed` only through `validate`.
 */
export function readWork(submission: Submission, report: ValidationReport, deps: readonly Dependency[]): WorkReading {
  const refuse = (reason: string): WorkReading => ({ done: false, reason, helpers: "" });
  if (report.leanStatus === undefined || report.leanStatus === "server_error" || report.leanStatus === "timeout") return refuse("Lean did not check the file");
  if (report.editsOutsideRegions) return refuse("the file was changed outside the regions");
  if (report.messages.some((m) => m.severity === "error")) return refuse("Lean reports an error");
  const helpers: string[] = [];
  for (const command of splitCommands(submission.aux)) {
    if (command.kind !== "code") continue;
    const text = command.text.trimEnd();
    const head = readDeclarationHead(text);
    const dep = head === undefined ? undefined : deps.find((d) => d.name === head.name);
    if (dep === undefined) {
      if (hasHole(text)) return refuse(`a helper lemma has a sorry${head !== undefined ? ` (${head.name})` : ""}`);
      // The link lemma takes the dependencies as hypotheses, so a helper that names one cannot be lifted out of the stubs.
      const used = deps.find((d) => mentions(text, d.name));
      if (used !== undefined) return refuse(`a helper lemma${head !== undefined ? ` (${head.name})` : ""} uses the given lemma ${used.name}: use a given lemma only inside the proof of the hole itself, and keep the helpers free of them`);
      helpers.push(text);
      continue;
    }
    let stub = false;
    try {
      const sketch = prepareSketch(text, dep.name);
      stub = sketch.originalProof.trim() === "sorry" && same(sketch.statement, dep.statement);
    } catch {
      stub = false;
    }
    if (!stub) return refuse(`${dep.name} is a given lemma: keep its statement and its sorry as they are`);
  }
  if (hasHole(submission.proof)) return refuse("the proof has a sorry");
  return { done: true, helpers: helpers.join("\n\n") };
}
