import { maskCommentsAndStrings, readDeclarationHead, splitCommands } from "@seshat/core";

/**
 * The closed vocabulary of an attempt's strategy (plan §2, "Attempt"). A label says how a proof
 * goes about the statement, not how it ends: `induction` for a proof by induction whatever closes
 * its cases.
 */
export const STRATEGIES = [
  "induction",
  "cases",
  "contradiction",
  "computation",
  "automation",
  "construction",
  "counterexample",
  "generalization",
  "rewriting",
  "algebra",
  "bounds",
  "extremal",
  "other",
] as const;

export type Strategy = (typeof STRATEGIES)[number];

export function isStrategy(value: unknown): value is Strategy {
  return typeof value === "string" && (STRATEGIES as readonly string[]).includes(value);
}

/** What a strategy is read from: the two regions a prover submits. */
export interface ProofText {
  /** Auxiliary lemmas. */
  aux?: string;
  /** The tactic proof of the theorem. */
  proof: string;
}

/** A Lean identifier, with the `.` of a namespace and the `?`, `!` and `'` that tactics end with. */
const TOKEN = /[\p{L}_][\p{L}\p{N}_'!?.₀-₉]*/gu;

/** Tactic words and other keywords that are not the name of a premise. */
const TACTIC_WORDS = new Set(
  `intro intros rintro obtain rcases cases induction induct generalize generalizing revert specialize have let set show suffices
   exact apply refine convert use exists existsi constructor left right ext funext congr symm trans calc
   simp simp_all simp_arith simpa simp_rw dsimp norm_num norm_cast push_cast push_neg exact_mod_cast apply_mod_cast
   rw rwa rewrite erw nth_rewrite nth_rw conv subst subst_vars unfold delta change rfl
   decide native_decide omega linarith nlinarith positivity gcongr bound tauto trivial assumption aesop grind
   ring ring_nf ring1 field_simp linear_combination abel group noncomm_ring module polyrith
   by_contra by_contradiction by_cases contradiction exfalso absurd interval_cases fin_cases split_ifs split
   contrapose apply_fun lift choose clear rename_i all_goals any_goals first repeat try iterate swap
   fun_prop continuity measurability canonical hint ac_rfl bv_decide norm_num1 refine' cases' induction'
   with using at only fun at_least from this then else if match termination_by decreasing_by theorem lemma def
   mod_cast nofun nomatch sorry`
    .split(/\s+/)
    .filter((word) => word !== ""),
);

/** Names that are a hypothesis of the proof, not a lemma: `h`, `ha`, `hab`, `h1`, `ih`, `h_pos`. */
const LOCAL_NAME = /^(?:h[a-z]{0,2}\d*|ih[a-z0-9]*)(?:_\w*)?$/;

/** The token without the `?`, `!` or `'` that makes it a variant of a tactic: `induction'`, `simp?`. */
function base(token: string): string {
  return token.replace(/[?!']+$/u, "");
}

function lastComponent(token: string): string {
  return token.slice(token.lastIndexOf(".") + 1);
}

/** The name of a lemma a token refers to, or undefined for a local, a tactic or anything shorter. */
function lemmaName(token: string): string | undefined {
  const t = token.replace(/\.+$/u, "");
  if (t === "" || TACTIC_WORDS.has(base(t))) return undefined;
  if (/^[A-Z][\w']*(?:\.[\w'?!]+)+$/u.test(t)) return t;
  const head = t.split(".")[0] as string;
  if (LOCAL_NAME.test(head) || head.startsWith("aux_")) return undefined;
  return /^[a-z][a-z0-9']*(?:_[a-zA-Z0-9']+)+$/.test(head) ? head : undefined;
}

interface Features {
  /** The text without comments and strings. */
  text: string;
  /** Every identifier, as written. */
  tokens: string[];
  /** The identifiers without the `?`, `!` or `'` that ends a variant of a tactic. */
  words: Set<string>;
  /** The lemmas that `exact`, `apply`, `refine`... are given. */
  applied: string[];
  /** An auxiliary lemma calls itself: a proof by recursion. */
  recursive: boolean;
}

function features(source: ProofText): Features {
  const aux = maskCommentsAndStrings(source.aux ?? "");
  const text = `${aux}\n${maskCommentsAndStrings(source.proof)}`;
  const tokens = [...text.matchAll(TOKEN)].map((m) => m[0].replace(/\.+$/u, ""));
  const applied = [
    ...text.matchAll(/\b(?:exact|apply|refine'?|exact_mod_cast|apply_mod_cast|convert|trans)\s+(?:\(\s*)*([^\s()⟨⟩,;:=]+)/gu),
  ].flatMap((m) => {
    const name = lemmaName(m[1] as string);
    return name === undefined ? [] : [name];
  });
  return { text, tokens, words: new Set(tokens.map(base)), applied, recursive: callsItself(aux) };
}

/** Whether an auxiliary theorem names itself in its own proof: induction written as recursion. */
function callsItself(aux: string): boolean {
  for (const command of splitCommands(aux)) {
    if (command.kind !== "code") continue;
    const head = readDeclarationHead(command.text);
    if (head === undefined || head.name === "" || (head.keyword !== "theorem" && head.keyword !== "lemma")) continue;
    const body = command.text.slice(head.nameEnd);
    const escaped = head.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?<![\\p{L}\\p{N}_'.])${escaped}(?![\\p{L}\\p{N}_'])`, "u").test(body)) return true;
  }
  return false;
}

const has = (f: Features, ...names: string[]): boolean => names.some((name) => f.words.has(name));

/**
 * The strategies, from the most to the least specific. A proof gets the first label whose test it
 * passes, so `induction n with ...` closed by `simp` and `omega` is an induction.
 */
const RULES: ReadonlyArray<readonly [Strategy, (f: Features) => boolean]> = [
  [
    "induction",
    (f) =>
      f.recursive ||
      has(f, "induction", "induct", "strong_induction") ||
      f.tokens.some((t) => t.includes(".") && (/induction/i.test(lastComponent(t)) || /^(?:rec|recOn|rec_on|recAux|strongRecOn|strong_rec_on)$/.test(lastComponent(t)))),
  ],
  [
    "extremal",
    (f) => /pigeonhole|exists_ne_map_eq|card_fiber|exists_lt_card|\bNat\.find|exists_(?:min|max)|\.(?:max|min)'|[wW]ell[_]?[fF]ounded|\bs(?:Inf|Sup)\b|IsLeast|IsGreatest|argm(?:in|ax)|minimal|maximal/.test(f.text),
  ],
  [
    "counterexample",
    (f) => /\bnot_forall\b/.test(f.text) || (has(f, "push_neg") && (has(f, "use", "exists", "existsi") || /\b(?:refine'?|exact)\s+⟨/.test(f.text))),
  ],
  ["contradiction", (f) => has(f, "by_contra", "by_contradiction", "contradiction", "exfalso", "absurd", "byContradiction") || f.tokens.some((t) => /(?:^|\.)byContradiction$/.test(t))],
  [
    "cases",
    (f) =>
      has(f, "cases", "rcases", "by_cases", "match", "interval_cases", "fin_cases", "split_ifs", "split", "casesOn") ||
      /\bobtain\b[^\n:]*\|/.test(f.text) ||
      f.tokens.some((t) => /(?:^|\.)(?:Or\.elim|lt_trichotomy|lt_or_ge|le_or_lt|em)$/.test(t)),
  ],
  ["generalization", (f) => has(f, "generalize", "generalizing", "revert", "strengthen")],
  ["construction", (f) => has(f, "use", "exists", "existsi") || /\b(?:refine'?|exact|apply)\s+⟨/.test(f.text) || f.tokens.includes("Exists.intro")],
  [
    "bounds",
    (f) =>
      has(f, "nlinarith", "positivity", "gcongr", "bound") ||
      (has(f, "calc") && /[≤<≥>]/.test(f.text)) ||
      f.applied.some((name) => name.split(/[._]/).some((part) => ["le", "lt", "ge", "gt", "nonneg", "pos", "abs", "trans"].includes(part))),
  ],
  ["algebra", (f) => has(f, "ring", "ring_nf", "ring1", "field_simp", "linear_combination", "abel", "group", "noncomm_ring", "module", "polyrith", "calc")],
  [
    "rewriting",
    (f) => has(f, "rw", "rwa", "rewrite", "erw", "nth_rewrite", "nth_rw", "simp_rw", "conv", "subst", "subst_vars", "unfold", "delta") || /\bsimp\s+only\b/.test(f.text) || f.applied.length > 0,
  ],
  ["computation", (f) => has(f, "decide", "native_decide", "norm_num", "norm_num1", "rfl", "reduce")],
  [
    "automation",
    (f) =>
      has(f, "simp", "simp_all", "simp_arith", "simpa", "aesop", "omega", "linarith", "grind", "tauto", "trivial", "assumption", "hint", "canonical", "bv_decide", "ac_rfl", "fun_prop", "continuity", "measurability") ||
      f.tokens.some((t) => /^(?:exact|apply|rw|refine)\?$/.test(t)),
  ],
];

/**
 * The strategy of a submitted proof, from the tactics and terms it uses and never from what it
 * says about itself: deterministic, so that the same text always gets the same label. It reads the
 * two regions without their comments, and gives the first label of `STRATEGIES`' rules (the list
 * above, from induction down to automation) that the text meets, `other` when it meets none. This
 * is a lexical reading: it does not follow what a tactic does.
 */
export function classifyStrategy(source: ProofText): Strategy {
  const f = features(source);
  return RULES.find(([, test]) => test(f))?.[0] ?? "other";
}

/** The most premises one proof lists. */
const MAX_PREMISES = 24;

/**
 * The lemmas a proof names, in the order it first does: qualified names such as `Nat.add_comm`
 * and snake_case names such as `add_comm`, left out when they are a hypothesis the proof
 * introduces (`h`, `h_pos`...), a tactic, or one of the prover's own `aux_` lemmas. This is a
 * lexical reading, which can list a definition or miss a lemma used through notation; the exact
 * premises come from the Lean meta tool.
 */
export function premisesOf(source: ProofText): string[] {
  const text = `${maskCommentsAndStrings(source.aux ?? "")}\n${maskCommentsAndStrings(source.proof)}`;
  const bound = new Set<string>();
  const bind = (span: string | undefined) => {
    for (const m of (span ?? "").matchAll(TOKEN)) bound.add(m[0]);
  };
  for (const m of text.matchAll(/\b(?:intro|intros|rintro)\b([^\n;]*)/gu)) bind(m[1]);
  for (const m of text.matchAll(/\b(?:have|let|set|obtain|suffices)\b([^\n:]*?)(?::=|:|\n|$)/gu)) bind(m[1]);
  for (const m of text.matchAll(/\bwith\b([^\n=]*)/gu)) bind(m[1]);
  for (const m of text.matchAll(/^\s*\|\s*([^\n=]*?)=>/gmu)) bind(m[1]);
  for (const m of text.matchAll(/\b(?:fun|λ)\b([^\n]*?)(?:=>|↦)/gu)) bind(m[1]);
  const premises = new Set<string>();
  for (const m of text.matchAll(TOKEN)) {
    const name = lemmaName(m[0]);
    if (name !== undefined && !bound.has(name) && !bound.has(m[0])) premises.add(name);
    if (premises.size >= MAX_PREMISES) break;
  }
  return [...premises];
}
