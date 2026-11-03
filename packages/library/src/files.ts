import type { MemoryStore } from "@seshat/memory";
import { lemmaText } from "./lemmas.ts";
import { type LibraryLemma, usableLemmas } from "./records.ts";

/** `msc:11` is the module `SeshatLib.Msc11`; a domain with no letters or digits is `General` (Ruling 26). */
export function moduleName(domain: string): string {
  const parts = domain.split(/[^A-Za-z0-9]+/).filter((p) => p !== "");
  const name = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
  return `SeshatLib.${/^[A-Za-z]/.test(name) ? name : name === "" ? "General" : `D${name}`}`;
}

/** The relative path of a module's file in `lean/`: `SeshatLib/Msc11.lean`. */
export function modulePath(module: string): string {
  return `${module.replace(/\./g, "/")}.lean`;
}

function comment(text: string): string {
  return text.replace(/-\//g, "- /");
}

function provenance(l: LibraryLemma): string {
  return comment(
    [
      `Library lemma ${l.name}, from ${l.source.name} of problem ${l.source.problemId} (attempt ${l.source.attemptId}).`,
      `Claim ${l.claimId} (${l.claimStatus}), statement ${l.statementId}.`,
      `${l.mathlibRev !== undefined ? `Mathlib revision ${l.mathlibRev}` : "Mathlib revision unknown"}${l.leanEnv !== undefined ? `, Lean environment ${l.leanEnv.name}${l.leanEnv.hash !== null ? `@${l.leanEnv.hash.slice(0, 12)}` : ""}` : ""}${l.promotedAt !== undefined ? `, promoted ${l.promotedAt}` : ""}.`,
    ].join("\n    "),
  );
}

/**
 * The text of the file of one module: the union of the lemmas' imports, then a namespace with every lemma in the
 * order it was promoted, each under a comment with its provenance. The file is generated from the journal and
 * never edited by hand. Nothing here has been compiled by Lean: the lemma's proof was checked in the problem's
 * file, and standing alone as a claim of its own, by the validator; a Lean host compiles this copy.
 */
export function renderLibraryFile(module: string, lemmas: readonly LibraryLemma[]): string {
  const imports = [...new Set(lemmas.flatMap((l) => l.header.split("\n").map((x) => x.trim()).filter((x) => x.startsWith("import "))))].sort();
  const body = lemmas.map((l) => `/- ${provenance(l)} -/\n${lemmaText(l)}`).join("\n\n");
  return [
    `/-`,
    `  ${module}: lemmas that the harness proved on earlier problems and promoted (documentation/library.md).`,
    `  Generated from the run's journal by \`harness library export\`. Do not edit: a change is made by the journal.`,
    `-/`,
    ...(imports.length > 0 ? ["", ...imports] : []),
    "",
    `namespace ${module}`,
    "",
    body,
    "",
    `end ${module}`,
    "",
  ].join("\n");
}

/** The library as files, by relative path (`SeshatLib/Msc11.lean`): the usable lemmas of the memory, grouped by domain. */
export function libraryFiles(memory: MemoryStore): Map<string, string> {
  const byModule = new Map<string, LibraryLemma[]>();
  for (const lemma of usableLemmas(memory)) {
    const module = moduleName(lemma.domain);
    byModule.set(module, [...(byModule.get(module) ?? []), lemma]);
  }
  return new Map([...byModule].sort(([a], [b]) => (a < b ? -1 : 1)).map(([module, lemmas]) => [modulePath(module), renderLibraryFile(module, lemmas)]));
}
