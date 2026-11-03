import { screenProse } from "@seshat/memory";
import { importsOf, prepareSketch, readDeclarationHead, SketchError, splitCommands } from "@seshat/core";
import { signatureProblem } from "@seshat/memory";

/** The prefix an auxiliary lemma's name must have in a problem's file (documentation/validator.md). */
export const AUX_PREFIX = "aux_";

/** The prefix of a library lemma's name: what the prover pastes into its auxiliary region. */
export const LIB_PREFIX = "aux_lib_";

/** An auxiliary lemma read out of a submission's auxiliary region. */
export interface ParsedLemma {
  /** The name it has in the submission: `aux_foo`. */
  name: string;
  /** Its statement in signature form: the binders, then `:` and the type. */
  statement: string;
  /** Its proof as tactics, without `by`; a term proof is `exact term`. */
  proof: string;
  /** The text of its docstring, without the comment marks. */
  doc?: string;
  /** The names of other `aux_` declarations of the region it uses: it does not stand alone. */
  uses: string[];
}

/** A declaration of the region that cannot be a library lemma, and why. */
export interface SkippedDeclaration {
  name: string;
  reason: string;
}

export interface ParsedRegion {
  lemmas: ParsedLemma[];
  skipped: SkippedDeclaration[];
}

/** `import X` lines for the modules a file imports, in the form `lean.check` reads as a header. */
export function importHeader(source: string): string {
  const modules = importsOf(source);
  return modules.length === 0 ? "" : modules.map((m) => `import ${m}`).join("\n");
}

function docOf(text: string): string | undefined {
  const m = /^\/--([\s\S]*?)-\/\s*$/.exec(text.trim());
  const doc = m?.[1]?.replace(/\s+/g, " ").trim();
  return doc === undefined || doc === "" ? undefined : doc;
}

/**
 * The lemmas of a submission's auxiliary region. A declaration is read with the sketch scanner of the
 * validator (so the statement and the proof are cut exactly as the validator cuts them); it is a lemma
 * when it is a `theorem` or `lemma` named `aux_...` with a statement in signature form, and it is left
 * out, with the reason, when it is a definition, has no `:=` proof, or uses another `aux_` declaration of
 * the region (it would not stand alone in the library).
 */
export function parseAuxRegion(aux: string): ParsedRegion {
  const lemmas: ParsedLemma[] = [];
  const skipped: SkippedDeclaration[] = [];
  const commands = splitCommands(aux);
  commands.forEach((command, k) => {
    if (command.kind !== "code") return;
    const head = readDeclarationHead(command.text);
    if (head === undefined || head.name === "") return;
    if (head.keyword !== "theorem" && head.keyword !== "lemma") {
      skipped.push({ name: head.name, reason: `a ${head.keyword}, not a lemma` });
      return;
    }
    if (!head.name.startsWith(AUX_PREFIX)) {
      skipped.push({ name: head.name, reason: `its name does not start with ${AUX_PREFIX}` });
      return;
    }
    const previous = commands[k - 1];
    const doc = previous?.kind === "docstring" ? docOf(previous.text) : undefined;
    let sketch;
    try {
      sketch = prepareSketch(`${command.text.trim()}\n`, head.name);
    } catch (error) {
      skipped.push({ name: head.name, reason: error instanceof SketchError ? error.message : String(error) });
      return;
    }
    const problem = signatureProblem(sketch.statement);
    if (problem !== undefined) {
      skipped.push({ name: head.name, reason: `its statement is not in signature form: ${problem}` });
      return;
    }
    const names = new Set(commands.flatMap((c) => (c.kind === "code" ? [readDeclarationHead(c.text)?.name] : [])).filter((n): n is string => n !== undefined && n.startsWith(AUX_PREFIX) && n !== head.name));
    const body = `${sketch.statement}\n${sketch.originalProof}`;
    const uses = [...names].filter((n) => new RegExp(`(?<![\\w.'])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w'])`).test(body)).sort();
    if (sketch.originalProof.trim() === "" || /\b(sorry|admit)\b/.test(sketch.originalProof)) {
      skipped.push({ name: head.name, reason: "its proof is empty or has a hole" });
      return;
    }
    if (uses.length > 0) {
      skipped.push({ name: head.name, reason: `it uses ${uses.join(", ")}, declared beside it` });
      return;
    }
    lemmas.push({ name: head.name, statement: sketch.statement, proof: sketch.originalProof, ...(doc !== undefined ? { doc } : {}), uses });
  });
  return { lemmas, skipped };
}

/** A short, stable suffix of a statement id: the digits after the version prefix. */
export function idSuffix(statementId: string): string {
  return (statementId.replace(/^[a-z0-9]+_/, "").match(/[0-9a-f]/gi) ?? []).slice(0, 6).join("").toLowerCase();
}

/** The name a lemma has in the library: `aux_lib_<stem>_<suffix of its statement id>`. */
export function libraryName(originalName: string, statementId: string): string {
  const stem = originalName.replace(/^aux_/, "").replace(/^lib_/, "").replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40) || "lemma";
  return `${LIB_PREFIX}${stem}_${idSuffix(statementId)}`;
}

/** The longest gloss that is kept. */
export const MAX_GLOSS = 160;

/**
 * A docstring or comment as a gloss: the prover's own prose (or a bench file's) is not verified, so it is kept only when it
 * passes the strict screen, on one line and cut short; otherwise there is no gloss (review I2, Global Constraint 16).
 */
export function glossOf(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const r = screenProse(text, { max: MAX_GLOSS });
  return r.ok ? r.text : undefined;
}

/** The Lean text of a library lemma, ready to paste into the auxiliary region (or to put in a file). */
export function lemmaText(lemma: { name: string; statement: string; proof: string; doc?: string }): string {
  const safe = lemma.doc === undefined ? undefined : glossOf(lemma.doc);
  const doc = safe === undefined ? "" : `/-- ${safe} -/\n`;
  const proof = lemma.proof
    .split("\n")
    .map((l) => (l.trim() === "" ? "" : `  ${l}`))
    .join("\n");
  return `${doc}theorem ${lemma.name} ${lemma.statement} := by\n${proof}`;
}
