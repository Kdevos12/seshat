import { wordsOf } from "./backends.ts";
import { clean } from "./text.ts";

/**
 * The three query forms of a statement (plan change CA16), made without a model: the words of the statement, the statement itself (the
 * person's prose when there is some, otherwise the Lean statement with its symbols read as words), and the words with the vocabulary of
 * a refutation. The queries are plain words: nothing of the statement's Lean syntax is sent.
 */
export interface QueryForm {
  form: "words" | "statement" | "refutation";
  query: string;
}

const LEAN_NOISE = new Set(["theorem", "lemma", "solve", "target", "nat", "int", "real", "rat", "complex", "finset", "set", "fun", "sorry", "type", "prop", "true", "false", "answer", "fin", "range", "card", "mathlib", "import", "open", "namespace", "decidable", "instance", "sub", "mul", "add", "pow", "succ", "cast", "ofnat"]);
const SYMBOLS: Array<[RegExp, string]> = [
  [/∑/g, " sum "],
  [/∏/g, " product "],
  [/∀/g, " for all "],
  [/∃/g, " exists "],
  [/∣/g, " divides "],
  [/≡/g, " congruent "],
  [/!/g, " factorial "],
  [/√/g, " square root "],
  [/ℕ/g, " natural numbers "],
  [/ℤ/g, " integers "],
  [/ℝ/g, " real numbers "],
  [/ℚ/g, " rational numbers "],
  [/ℂ/g, " complex numbers "],
];

/** A Lean text read as words: identifiers split on dots, underscores and camel case, symbols named, binders' single letters dropped. */
export function leanWords(lean: string): string {
  let text = lean.replace(/--.*$/gm, " ").replace(/\/-[\s\S]*?-\//g, " ");
  for (const [pattern, word] of SYMBOLS) text = text.replace(pattern, word);
  text = text.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_.]/g, " ");
  const words = text.match(/[\p{L}]{3,}/gu) ?? [];
  return words.filter((w) => !LEAN_NOISE.has(w.toLowerCase())).join(" ");
}

/** The docstring that stands just before a declaration, in the text above it (a file's prefix): what a bench file says of its problem in words. */
export function docstringBefore(prefix: string): string | undefined {
  const found = /\/--([\s\S]*?)-\/\s*(?:@\[[^\]]*\]\s*)*$/.exec(prefix);
  const doc = found?.[1]?.replace(/\s+/g, " ").trim();
  return doc === undefined || doc === "" ? undefined : doc;
}

/**
 * `statement` is the Lean statement (binders and type), `prose` the person's words, `name` the declaration's name (a bench problem is
 * often named for its source), `doc` the docstring above it. Words come from the person's prose, or from the docstring, name and statement.
 */
export function queryForms(s: { statement: string; prose?: string; name?: string; doc?: string }): QueryForm[] {
  const said = s.prose !== undefined && s.prose.trim() !== "" ? s.prose : s.doc;
  const source = said !== undefined && said.trim() !== "" ? said : [leanWords(s.name ?? ""), leanWords(s.statement)].join(" ");
  const words = wordsOf(source).slice(0, 8).join(" ");
  const forms: QueryForm[] = [
    { form: "words", query: words },
    { form: "statement", query: clean(source, 200) },
    { form: "refutation", query: `${wordsOf(source).slice(0, 5).join(" ")} conjecture counterexample disproof`.trim() },
  ];
  const seen = new Set<string>();
  return forms.filter((f) => {
    const key = f.query.toLowerCase();
    if (f.query === "" || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
