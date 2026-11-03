import { stripLeanComments } from "@seshat/core";

/**
 * Lean statements and proofs as token trees, for the schemas of line M15 (documentation/schemas.md): the anti-unification of two
 * statements, the matching of a statement against a skeleton, and the instantiation of a skeleton. There is no Lean here: the trees
 * are lexical (identifiers, numerals, symbols, bracket groups), so what a match says about a statement is checked by `lean.meta`
 * afterwards, and what an instantiation writes is a statement Lean reads like any other.
 *
 * A variable (`Var`, written `?3` in a skeleton) stands for one token or one bracketed group, or for the whole contents of a group
 * or of a statement when it is alone there. That keeps precedence out of it: a variable is never a part of an infix expression.
 */

export interface Leaf {
  kind: "leaf";
  text: string;
  /** The whitespace before the token in its source. */
  pre: string;
}

export interface Group {
  kind: "group";
  open: string;
  close: string;
  pre: string;
  closePre: string;
  kids: Node[];
}

export interface Var {
  kind: "var";
  id: number;
  pre: string;
}

export type Node = Leaf | Group | Var;

const BRACKETS: ReadonlyMap<string, string> = new Map([
  ["(", ")"], ["[", "]"], ["{", "}"], ["⟨", "⟩"], ["⦃", "⦄"], ["⟦", "⟧"], ["‹", "›"], ["⌊", "⌋"], ["⌈", "⌉"],
]);
const CLOSERS = new Set(BRACKETS.values());
const IDENT = "[\\p{L}_][\\p{L}\\p{N}_'!?₀-₉ₐ-ₜ]*";
const TOKEN = new RegExp(
  `(\\s*)(\\?\\d+|${IDENT}(?:\\.${IDENT})*|\\d+(?:\\.\\d+)?|:=|<->|->|=>|<=|>=|!=|&&|\\|\\||\\+\\+|::|\\.\\.|[^\\s])`,
  "uy",
);

/** Tokens of a text, with the whitespace before each; a dotted name is cut at its dots (`Nat.succ` is `Nat`, `.succ`). */
function tokens(text: string): Array<{ text: string; pre: string }> {
  const out: Array<{ text: string; pre: string }> = [];
  TOKEN.lastIndex = 0;
  let at = 0;
  while (at < text.length) {
    TOKEN.lastIndex = at;
    const m = TOKEN.exec(text);
    if (m === null) break;
    at = TOKEN.lastIndex;
    const word = m[2] as string;
    const pieces = /^[\p{L}_]/u.test(word) && word.includes(".") ? word.split(/(?=\.)/) : [word];
    pieces.forEach((piece, k) => out.push({ text: piece, pre: k === 0 ? (m[1] as string) : "" }));
  }
  return out;
}

/** Reads a statement or a proof as a sequence of nodes. Throws when the brackets do not match. */
export function parseNodes(text: string): Node[] {
  const root: Node[] = [];
  const stack: Array<{ group: Group; into: Node[] }> = [];
  let current = root;
  for (const token of tokens(stripLeanComments(text))) {
    const close = BRACKETS.get(token.text);
    if (close !== undefined) {
      const group: Group = { kind: "group", open: token.text, close, pre: token.pre, closePre: "", kids: [] };
      current.push(group);
      stack.push({ group, into: current });
      current = group.kids;
    } else if (CLOSERS.has(token.text)) {
      const top = stack.pop();
      if (top === undefined || top.group.close !== token.text) throw new Error(`unbalanced bracket ${token.text}`);
      top.group.closePre = token.pre;
      current = top.into;
    } else if (/^\?\d+$/.test(token.text)) {
      current.push({ kind: "var", id: Number(token.text.slice(1)), pre: token.pre });
    } else {
      current.push({ kind: "leaf", text: token.text, pre: token.pre });
    }
  }
  if (stack.length > 0) throw new Error("unclosed bracket");
  return root;
}

/** The text of nodes; a variable is written by `name` (default `?3`). The first token's whitespace is dropped. */
export function renderNodes(nodes: readonly Node[], name: (id: number) => string = (id) => `?${id}`): string {
  const go = (list: readonly Node[]): string =>
    list
      .map((n) => (n.kind === "leaf" ? n.pre + n.text : n.kind === "var" ? n.pre + name(n.id) : `${n.pre}${n.open}${go(n.kids)}${n.closePre}${n.close}`))
      .join("");
  return go(nodes).replace(/^\s+/, "");
}

/** The same node ignoring whitespace. */
export function sameNode(a: Node, b: Node): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "leaf") return a.text === (b as Leaf).text;
  if (a.kind === "var") return a.id === (b as Var).id;
  const g = b as Group;
  return a.open === g.open && sameNodes(a.kids, g.kids);
}

export function sameNodes(a: readonly Node[], b: readonly Node[]): boolean {
  return a.length === b.length && a.every((n, k) => sameNode(n, b[k] as Node));
}

const withPre = <T extends Node>(node: T, pre: string): T => ({ ...node, pre });

/** The variables of nodes, in order of first appearance. */
export function varsOf(nodes: readonly Node[], into: number[] = []): number[] {
  for (const n of nodes) {
    if (n.kind === "var" && !into.includes(n.id)) into.push(n.id);
    else if (n.kind === "group") varsOf(n.kids, into);
  }
  return into;
}

/** How many tokens are fixed and how many are variables, brackets counting as one fixed token each. */
export function weigh(nodes: readonly Node[]): { fixed: number; vars: number } {
  let fixed = 0;
  let vars = 0;
  for (const n of nodes) {
    if (n.kind === "var") vars += 1;
    else if (n.kind === "leaf") fixed += 1;
    else {
      fixed += 1;
      const inner = weigh(n.kids);
      fixed += inner.fixed;
      vars += inner.vars;
    }
  }
  return { fixed, vars };
}

/** The share of fixed tokens in the skeleton: 1 for a statement with no variable, 0 for a variable alone. */
export function specificity(skeleton: readonly (readonly Node[])[]): number {
  let fixed = 0;
  let vars = 0;
  for (const nodes of skeleton) {
    const w = weigh(nodes);
    fixed += w.fixed;
    vars += w.vars;
  }
  return fixed + vars === 0 ? 0 : fixed / (fixed + vars);
}

// -- anti-unification ---------------------------------------------------------------------------------------------

const keyOf = (n: Node): string => (n.kind === "leaf" ? `L:${n.text}` : n.kind === "var" ? "V" : `G:${n.open}`);

/** The pairs of indexes of a longest common subsequence of the nodes' keys. */
function align(a: readonly Node[], b: readonly Node[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = keyOf(a[i] as Node) === keyOf(b[j] as Node) ? (table[i + 1]![j + 1] as number) + 1 : Math.max(table[i + 1]![j] as number, table[i]![j + 1] as number);
    }
  }
  const out: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (keyOf(a[i] as Node) === keyOf(b[j] as Node)) {
      out.push([i, j]);
      i += 1;
      j += 1;
    } else if ((table[i + 1]![j] as number) >= (table[i]![j + 1] as number)) i += 1;
    else j += 1;
  }
  return out;
}

/** What anti-unifications of several statements share, so that one pair of differing subterms is one variable. */
export interface AuContext {
  /** The new variable of a pair of subterms, by their texts. */
  pairs: Map<string, number>;
  next: number;
}

export const newAuContext = (): AuContext => ({ pairs: new Map(), next: 1 });

function pairVar(c: AuContext, left: string, right: string, pre: string): Var {
  const key = `${left}\u0000${right}`;
  let id = c.pairs.get(key);
  if (id === undefined) {
    id = c.next;
    c.next += 1;
    c.pairs.set(key, id);
  }
  return { kind: "var", id, pre };
}

/**
 * The least general generalization of two sequences (Plotkin's anti-unification, over tokens): what they share is kept, and
 * where they differ a variable stands, the same variable for the same pair of subterms. The differing stretches between two
 * shared tokens must have the same length, matched one position to one (a stretch longer on one side has no
 * variable that stands for one token or one group), or the whole level fails and the group that holds it becomes one variable.
 * Undefined when the top level fails.
 */
export function antiUnify(a: readonly Node[], b: readonly Node[], c: AuContext): Node[] | undefined {
  const out: Node[] = [];
  let ia = 0;
  let ib = 0;
  const differ = (x: Node, y: Node): Node => {
    if (x.kind === "var" && y.kind === "var") return pairVar(c, `a${x.id}`, `b${y.id}`, x.pre);
    return pairVar(c, renderNodes([x]), renderNodes([y]), x.pre);
  };
  for (const [i, j] of [...align(a, b), [a.length, b.length] as [number, number]]) {
    const gapA = a.slice(ia, i);
    const gapB = b.slice(ib, j);
    if (gapA.length !== gapB.length) return undefined;
    gapA.forEach((x, k) => out.push(differ(x, gapB[k] as Node)));
    if (i < a.length) {
      const x = a[i] as Node;
      const y = b[j] as Node;
      if (x.kind === "group" && y.kind === "group") {
        const kids = antiUnify(x.kids, y.kids, c);
        out.push(kids === undefined ? differ(x, y) : { ...x, kids });
      } else if (x.kind === "var" && y.kind === "var") out.push(differ(x, y));
      else out.push(x);
    }
    ia = i + 1;
    ib = j + 1;
  }
  return out;
}

/** The skeletons with their variables numbered 1, 2... in order of first appearance, and the new number of each old one. */
export function renumber(skeleton: readonly (readonly Node[])[]): { skeleton: Node[][]; map: Map<number, number> } {
  const map = new Map<number, number>();
  const go = (nodes: readonly Node[]): Node[] =>
    nodes.map((n): Node => {
      if (n.kind === "var") {
        if (!map.has(n.id)) map.set(n.id, map.size + 1);
        return { ...n, id: map.get(n.id) as number };
      }
      return n.kind === "group" ? { ...n, kids: go(n.kids) } : n;
    });
  return { skeleton: skeleton.map(go), map };
}

// -- matching and instantiation -----------------------------------------------------------------------------------

export type Bindings = ReadonlyMap<number, readonly Node[]>;

type Continue = (bindings: Bindings) => Bindings | undefined;

function walk(pat: readonly Node[], pi: number, tgt: readonly Node[], ti: number, bound: Bindings, k: Continue): Bindings | undefined {
  if (pi === pat.length) return ti === tgt.length ? k(bound) : undefined;
  const p = pat[pi] as Node;
  if (p.kind === "var") {
    const known = bound.get(p.id);
    if (known !== undefined) {
      const there = tgt.slice(ti, ti + known.length);
      return sameNodes(known, there) && there.length === known.length ? walk(pat, pi + 1, tgt, ti + known.length, bound, k) : undefined;
    }
    // One node, or all that is left when the variable is alone in its sequence.
    const length = pat.length === 1 ? tgt.length - ti : 1;
    if (length < 1 || ti + length > tgt.length) return undefined;
    return walk(pat, pi + 1, tgt, ti + length, new Map(bound).set(p.id, tgt.slice(ti, ti + length)), k);
  }
  const t = tgt[ti];
  if (t === undefined) return undefined;
  if (p.kind === "leaf") return t.kind === "leaf" && t.text === p.text ? walk(pat, pi + 1, tgt, ti + 1, bound, k) : undefined;
  if (t.kind !== "group" || t.open !== p.open) return undefined;
  return walk(p.kids, 0, t.kids, 0, bound, (b) => walk(pat, pi + 1, tgt, ti + 1, b, k));
}

/** Matches a skeleton against a statement: the bindings of its variables, or undefined. `given` are bindings the match must keep. */
export function matchNodes(pattern: readonly Node[], target: readonly Node[], given: Bindings = new Map()): Bindings | undefined {
  return walk(pattern, 0, target, 0, given, (b) => b);
}

/** The skeleton with its variables replaced by what they are bound to; the variables left unbound are listed. */
export function fillNodes(pattern: readonly Node[], bindings: Bindings): { nodes: Node[]; free: number[] } {
  const free: number[] = [];
  const go = (nodes: readonly Node[]): Node[] =>
    nodes.flatMap((n): Node[] => {
      if (n.kind === "var") {
        const bound = bindings.get(n.id);
        if (bound === undefined) {
          if (!free.includes(n.id)) free.push(n.id);
          return [n];
        }
        if (bound.length > 1 && nodes.length > 1) {
          // A stretch of several tokens among others keeps its meaning only in brackets.
          return [{ kind: "group", open: "(", close: ")", pre: n.pre, closePre: "", kids: bound.map((b, k) => (k === 0 ? withPre(b, "") : b)) }];
        }
        return bound.map((b, k) => (k === 0 ? withPre(b, n.pre) : b));
      }
      return [n.kind === "group" ? { ...n, kids: go(n.kids) } : n];
    });
  return { nodes: go(pattern), free };
}

// -- statements ---------------------------------------------------------------------------------------------------

/** The names a statement in signature form binds before its top-level colon: `(n m : ℕ) {k : ℕ}` gives n, m, k. */
export function binderNames(nodes: readonly Node[]): string[] {
  const names: string[] = [];
  for (const n of nodes) {
    if (n.kind === "leaf" && n.text === ":") break;
    if (n.kind === "group" && "([{⦃".includes(n.open)) {
      for (const kid of n.kids) {
        if (kid.kind === "leaf" && kid.text === ":") break;
        if (kid.kind === "leaf" && /^[\p{L}_]/u.test(kid.text) && !kid.text.startsWith(".")) names.push(kid.text);
      }
    } else if (n.kind === "leaf" && /^[\p{L}_]/u.test(n.text) && !n.text.startsWith(".")) names.push(n.text);
  }
  return names;
}

/** The nodes with each leaf named in `names` made the variable that `names` gives it. */
export function abstractNames(nodes: readonly Node[], names: ReadonlyMap<string, number>): Node[] {
  return nodes.map((n): Node => {
    if (n.kind === "leaf") {
      const id = names.get(n.text);
      return id === undefined ? n : { kind: "var", id, pre: n.pre };
    }
    return n.kind === "group" ? { ...n, kids: abstractNames(n.kids, names) } : n;
  });
}

const RELATIONS = ["↔", "→", "∨", "∧", "=", "≠", "≤", "<", "≥", ">", "∣", "∈", "∉", "⊆", "≡", "∀", "∃"];

/** The main symbol of a statement's type: the lowest-binding connective or relation at its top level, `pred` when there is none. */
export function headOf(statement: string): string {
  const nodes = parseNodes(statement);
  const colon = nodes.findIndex((n) => n.kind === "leaf" && n.text === ":");
  const type = nodes.slice(colon + 1);
  for (const symbol of RELATIONS) if (type.some((n) => n.kind === "leaf" && n.text === symbol)) return symbol;
  return "pred";
}
