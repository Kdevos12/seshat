import SeshatMeta.Statement

/-!
# `#seshat_hash`: the canonical id of a statement

`#seshat_hash (n : ℕ) : n + 0 = n` elaborates the statement, writes it in a canonical text, and
prints `{"id":"st1_<32 hexadecimal digits>"}`: the FNV-1a hash, on 128 bits, of that text.
`#seshat_hash <statement> using [ge_iff_le, gt_iff_lt]` first rewrites the statement with
`simp only` and these lemmas.

The canonical text (`documentation/lean-meta.md`, "The canonical form"):

```
#i              a bound variable, by its de Bruijn index
(S l)           a sort
(C n l…)        a constant, with its universe levels
(A f a…)        an application, flattened; a closed instance argument of a constant is `_`
(P t b)         a `∀`, and (L t b) a `fun`: no binder name, no binder kind
(Z t v b)       a `let` or a `have`
(N n), (T "s")  a natural number literal, a string literal
(J S i e)       the projection `i` of the structure `S`
```

Levels are written `0`, `(s l)`, `(max a b)`, `(imax a b)` and `u1`, `u2`…: the statement's
universe parameters are numbered in the order they first appear, then the level is normalized.
Metadata is dropped. An instance argument built from global instances only (closed) is `_`, so the
instance path elaboration took does not count; one that uses the statement's own instance binders
is written out, so that two instances of the same class are not confused. So bound names, binder
kinds and global instance paths do not change the id; anything else does.
-/

namespace SeshatMeta

open Lean Elab Meta

/-- The canonical text being written, and the universe parameters met so far. -/
structure Canonical where
  text : String := ""
  levelParams : Array Name := #[]

abbrev CanonicalM := StateT Canonical CoreM

def emit (s : String) : CanonicalM Unit :=
  modify fun c => { c with text := c.text ++ s }

/-- The position of `n` in `xs`. -/
def indexIn (xs : Array Name) (n : Name) : Option Nat := Id.run do
  for i in [0:xs.size] do
    if xs[i]! == n then return some i
  return none

/-- Renames the universe parameters `u1`, `u2`…, in the order they first appear. -/
partial def renameLevel : Level → CanonicalM Level
  | .zero => pure .zero
  | .succ l => return .succ (← renameLevel l)
  | .max a b => return .max (← renameLevel a) (← renameLevel b)
  | .imax a b => return .imax (← renameLevel a) (← renameLevel b)
  | .param n => do
    let params := (← get).levelParams
    let i ← match indexIn params n with
      | some i => pure i
      | none => do
        modify fun c => { c with levelParams := c.levelParams.push n }
        pure params.size
    return .param (Name.mkSimple s!"u{i + 1}")
  | .mvar _ => throwError "the statement has a universe level that Lean could not determine"

partial def levelText : Level → String
  | .zero => "0"
  | .succ l => s!"(s {levelText l})"
  | .max a b => s!"(max {levelText a} {levelText b})"
  | .imax a b => s!"(imax {levelText a} {levelText b})"
  | .param n => n.toString
  | .mvar _ => "?"

def emitLevel (l : Level) : CanonicalM Unit := do
  let renamed ← renameLevel l
  emit (levelText renamed.normalize)

partial def emitExpr (e : Expr) : CanonicalM Unit := do
  match e with
  | .bvar i => emit s!"#{i}"
  | .sort l =>
    emit "(S "
    emitLevel l
    emit ")"
  | .const n ls =>
    emit s!"(C {n}"
    for l in ls do
      emit " "
      emitLevel l
    emit ")"
  | .app .. =>
    let fn := e.getAppFn
    let args := e.getAppArgs
    let mut erased : Array Nat := #[]
    if let .const c _ := fn then
      let info ← getConstInfo c
      erased := (instanceParams info.type).map (·.1)
    emit "(A "
    emitExpr fn
    let mut i := 0
    for arg in args do
      emit " "
      if erased.contains i && !arg.hasLooseBVars then
        emit "_"
      else
        emitExpr arg
      i := i + 1
    emit ")"
  | .lam _ type body _ =>
    emit "(L "
    emitExpr type
    emit " "
    emitExpr body
    emit ")"
  | .forallE _ type body _ =>
    emit "(P "
    emitExpr type
    emit " "
    emitExpr body
    emit ")"
  | .letE _ type value body _ =>
    emit "(Z "
    emitExpr type
    emit " "
    emitExpr value
    emit " "
    emitExpr body
    emit ")"
  | .lit (.natVal n) => emit s!"(N {n})"
  | .lit (.strVal s) => emit s!"(T {s.quote})"
  | .mdata _ inner => emitExpr inner
  | .proj s i inner =>
    emit s!"(J {s} {i} "
    emitExpr inner
    emit ")"
  | .fvar _ => throwError "the statement is not closed: it has a free variable"
  | .mvar _ => throwError "the statement has a hole that Lean could not fill"

/-- The canonical text of a closed term. -/
def canonicalText (e : Expr) : CoreM String := do
  let ((), canonical) ← (emitExpr e).run {}
  return canonical.text

/-- FNV-1a on 128 bits over the UTF-8 bytes of `s`: offset basis
`0x6c62272e07bb014262b821756295c58d`, prime `2^88 + 2^8 + 0x3b`. -/
def fnv1a128 (s : String) : Nat :=
  s.toUTF8.foldl (init := 0x6c62272e07bb014262b821756295c58d) fun h b =>
    (Nat.xor h b.toNat * 0x1000000000000000000013b) % 2 ^ 128

/-- The 32 hexadecimal digits of a number below `2^128`. -/
def hex128 (h : Nat) : String := Id.run do
  let mut out := ""
  for i in [0:32] do
    out := out.push (Nat.digitChar ((h >>> (4 * (31 - i))) % 16))
  return out

/-- The statement's id: `st1_` and the hash of its canonical text. -/
def statementId (e : Expr) : CoreM String := do
  return s!"st1_{hex128 (fnv1a128 (← canonicalText e))}"

/-- Rewrites `e` with `simp only` and the given lemmas; `e` itself when there are none. -/
def simpOnly (names : Array Syntax) (e : Expr) : TermElabM Expr := do
  if names.isEmpty then return e
  let mut theorems : SimpTheorems := {}
  for name in names do
    theorems ← theorems.addConst (← realizeGlobalConstNoOverloadWithInfo name)
  let congr ← Meta.getSimpCongrTheorems
  let context ← Simp.mkContext (simpTheorems := #[theorems]) (congrTheorems := congr)
  let (result, _) ← Lean.Meta.simp e context
  instantiateMVars result.expr

/- `declSig` is `Lean.Parser.Command.declSig`, which the `open`s above do not reach: the parsers
are named in full, and the rules open its namespace. The form with `using` is a rule of its own
rather than an optional part, so that its pattern needs no optional splice. -/

syntax (name := seshatHash) "#seshat_hash " Lean.Parser.Command.declSig : command

syntax (name := seshatHashUsing) "#seshat_hash " Lean.Parser.Command.declSig
  " using " "[" ident,* "]" : command

open Lean.Parser.Command in
elab_rules : command
  | `(#seshat_hash $sig:declSig) => Command.liftTermElabM do
    answer [("id", Json.str (← statementId (← elabStatement sig)))]

open Lean.Parser.Command in
elab_rules : command
  | `(#seshat_hash $sig:declSig using [$names,*]) => Command.liftTermElabM do
    let statement ← elabStatement sig
    let statement ← simpOnly (names.getElems.map (·.raw)) statement
    answer [("id", Json.str (← statementId statement))]

end SeshatMeta
