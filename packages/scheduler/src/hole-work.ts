import { STANDARD_AXIOMS, collapseWhitespace, maskCommentsAndStrings, prepareSketch, readDeclarationHead, splitCommands, type Submission, type ValidationReport } from "@seshat/core";

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
  /** The work on the hole is done (CA10): no Lean error, and every `sorry` lies in a dependency stub (by the text scan and by Lean's own report). */
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

/** The axioms a hole's file may depend on: the validator's, and `sorryAx`, which the stubs bring in and which the link lemma removes. */
const WORK_AXIOMS: readonly string[] = [...STANDARD_AXIOMS, "sorryAx"];

/** The names of the declarations of the checked file that hold a `sorry` Lean reported, or undefined when a position falls in no declaration. */
function sorryOwners(report: ValidationReport): (string | undefined)[] {
  const lines = report.checked.split("\n");
  const offsets: number[] = [];
  let at = 0;
  for (const line of lines) {
    offsets.push(at);
    at += line.length + 1;
  }
  const commands = splitCommands(report.checked).filter((c) => c.kind === "code");
  return report.sorries.map((s) => {
    const offset = offsets[s.pos.line - 1];
    if (offset === undefined) return undefined;
    const command = commands.find((c) => c.start <= offset && offset < c.end) ?? commands.find((c) => c.start <= offset + s.pos.column && offset + s.pos.column < c.end);
    return command === undefined ? undefined : readDeclarationHead(command.text.trimEnd())?.name;
  });
}

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
  // Lean's own report, besides the text scan below: every sorry it reports lies in a dependency stub, and no axiom beyond the allowed ones.
  const stray = report.axioms.filter((a) => !WORK_AXIOMS.includes(a));
  if (stray.length > 0) return refuse(`the file depends on ${stray.join(", ")}: no axiom is allowed beyond the standard ones`);
  if (report.sorries.length > 0) {
    const owners = sorryOwners(report);
    const bad = owners.findIndex((name) => name === undefined || !deps.some((d) => d.name === name));
    if (bad >= 0) return refuse(`Lean reports a sorry outside the given lemmas${owners[bad] !== undefined ? ` (in ${owners[bad]})` : ""}: only the given lemmas keep their sorry`);
  }
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

/** The most characters of the claim's header a hole's prompt shows whole; a longer header is cut after its first lines. */
export const HOLE_HEADER_CHARS = 2500;
/** The most characters, in all, of the earlier sessions' failure reasons a hole's prompt repeats (the newest first kept). */
export const HOLE_HISTORY_CHARS = 900;

/** The header as the prompt shows it: whole when short, else its first lines (the imports and opens come first) and a line saying the rest is cut. */
export function cutHeader(header: string, max: number = HOLE_HEADER_CHARS): string {
  if (header.length <= max) return header;
  const lines = header.split("\n");
  const kept: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > max) break;
    kept.push(line);
    size += line.length + 1;
  }
  return `${kept.join("\n")}\n-- (${lines.length - kept.length} more line${lines.length - kept.length === 1 ? "" : "s"} of the header are cut here)`;
}

/** The earlier sessions' failure lines, oldest first, whose total size is at most `max`: the newest are kept, a line that does not fit is dropped. */
export function boundHistory(entries: readonly string[], max: number = HOLE_HISTORY_CHARS): string[] {
  const kept: string[] = [];
  let size = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as string;
    if (size + entry.length + 1 > max) break;
    kept.unshift(entry);
    size += entry.length + 1;
  }
  return kept;
}
