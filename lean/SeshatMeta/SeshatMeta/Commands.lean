import SeshatMeta.Statement

/-!
# `#seshat_defeq`, `#seshat_premises`, `#seshat_profile`, `#seshat_instances`

Each prints one line of JSON in an information message (`documentation/lean-meta.md`).
-/

namespace SeshatMeta

open Lean Elab Meta

/-! ## `#seshat_defeq a with b`

`{"defeq":true}` or `{"defeq":false}` when `isDefEq` decides within the heartbeat limit of the
command (`set_option maxHeartbeats N in #seshat_defeq …`), `{"defeq":null}` when it runs out. The
two statements are elaborated first; the limit counts from `isDefEq` on. -/

syntax (name := seshatDefeq) "#seshat_defeq " declSig " with " declSig : command

elab_rules : command
  | `(#seshat_defeq $a:declSig with $b:declSig) => Command.liftTermElabM do
    let a ← elabStatement a
    let b ← elabStatement b
    let defeq ← tryCatchRuntimeEx
      (do return Json.bool (← withCurrHeartbeats (isDefEq a b)))
      fun ex => if ex.isMaxHeartbeat then pure Json.null else throw ex
    answer [("defeq", defeq)]

/-! ## `#seshat_premises decl`

`{"premises":[…]}`: the theorems the value of `decl` uses (`Expr.getUsedConstants`, filtered to
theorems), looking through the auxiliary lemmas that elaboration creates (internal names such as
`foo._proof_1`). Sorted. -/

syntax (name := seshatPremises) "#seshat_premises " ident : command

/-- The theorems `value` uses, through auxiliary lemmas. -/
def premisesOf (env : Environment) (value : Expr) : Array String := Id.run do
  let mut seen : NameSet := {}
  let mut premises : Array String := #[]
  let mut todo := value.getUsedConstants.toList
  repeat
    match todo with
    | [] => break
    | c :: rest =>
      todo := rest
      if !seen.contains c then
        seen := seen.insert c
        if let some (.thmInfo info) := env.find? c then
          if c.isInternal then
            todo := info.value.getUsedConstants.toList ++ todo
          else
            premises := premises.push c.toString
  return sortedUnique premises

elab_rules : command
  | `(#seshat_premises $decl:ident) => Command.liftTermElabM do
    let name ← realizeGlobalConstNoOverloadWithInfo decl
    let info ← getConstInfo name
    let some value := info.value?
      | throwError "{name} has no value to read: it is an axiom, an opaque constant or a constructor"
    answer [("premises", toJson (premisesOf (← getEnv) value))]

/-! ## `#seshat_profile statement`

`{"classes":[…],"instances":[…]}`: the structure profile of the statement, for exact homologies.
`classes` are the classes of its instance-implicit binders and of the instance arguments of the
constants it applies; `instances` are the instances it uses (`Meta.isInstance`). Sorted. -/

syntax (name := seshatProfile) "#seshat_profile " declSig : command

structure Profile where
  classes : Array Name := #[]
  instances : Array Name := #[]

/-- Collects the classes and instances `e` involves. -/
partial def collectProfile (e : Expr) : StateT Profile CoreM Unit := do
  match e with
  | .forallE _ domain body info | .lam _ domain body info =>
    if info.isInstImplicit then
      if let some c := domain.getForallBody.getAppFn.constName? then
        modify fun p => { p with classes := p.classes.push c }
    collectProfile domain
    collectProfile body
  | .letE _ type value body _ =>
    collectProfile type
    collectProfile value
    collectProfile body
  | .mdata _ inner => collectProfile inner
  | .proj _ _ inner => collectProfile inner
  | .const c _ =>
    let env ← getEnv
    if isInstanceCore env c then
      modify fun p => { p with instances := p.instances.push c }
  | .app .. =>
    let fn := e.getAppFn
    let args := e.getAppArgs
    if let .const c _ := fn then
      let info ← getConstInfo c
      for (i, cls) in instanceParams info.type do
        if i < args.size && !cls.isAnonymous then
          modify fun p => { p with classes := p.classes.push cls }
    collectProfile fn
    for arg in args do
      collectProfile arg
  | _ => pure ()

elab_rules : command
  | `(#seshat_profile $sig:declSig) => Command.liftTermElabM do
    let statement ← elabStatement sig
    let ((), profile) ← (collectProfile statement).run {}
    answer [
      ("classes", toJson (sortedUnique (profile.classes.map toString))),
      ("instances", toJson (sortedUnique (profile.instances.map toString)))]

/-! ## `#seshat_instances statement using [fact₀, fact₁, …]`

`{"instanceOf":[…],"covers":[…]}`, positions in the list: the facts the statement is an instance
of (each one, once proved, proves it), and the facts that are instances of the statement (the
statement, once proved, covers them). The facts are constants: declarations of the file (an
`axiom` per statement) or of its imports. Their conclusions, with their variables and hypotheses
as metavariables, go into a discrimination tree (`Lean.Meta.DiscrTree`); the statement's
conclusion finds the candidates that unify with it (`DiscrTree.getUnify`), and `isInstanceOf`
confirms each candidate in both directions. -/

syntax (name := seshatInstances) "#seshat_instances " declSig " using " "[" ident,* "]" : command

/-- Whether `special` follows from `general` by instantiation, as `apply general` then
`assumption` would show it: with `special`'s variables and hypotheses fixed, `general`'s
conclusion (its variables and hypotheses as metavariables) unifies with `special`'s, and each of
`general`'s variables and hypotheses left open is closed by one of `special`'s. The hypotheses are
tried first, from the last, since they fix the variables they mention. -/
def isInstanceOf (special general : Expr) : MetaM Bool :=
  withoutModifyingState <| forallTelescopeReducing special fun _ conclusion => do
    let (mvars, _, generalConclusion) ← forallMetaTelescopeReducing general
    unless (← isDefEq generalConclusion conclusion) do return false
    for m in mvars.reverse do
      let id := m.mvarId!
      unless (← id.isAssigned) do
        let type ← instantiateMVars (← inferType m)
        let some h ← findLocalDeclWithType? type | return false
        id.assign (.fvar h)
    return true

elab_rules : command
  | `(#seshat_instances $sig:declSig using [$facts,*]) => Command.liftTermElabM do
    let statement ← elabStatement sig
    let mut types : Array Expr := #[]
    let mut index : DiscrTree Nat := DiscrTree.empty
    for fact in facts.getElems do
      let name ← realizeGlobalConstNoOverloadWithInfo fact
      let type ← instantiateMVars (← inferType (← mkConstWithFreshMVarLevels name))
      let (_, _, conclusion) ← forallMetaTelescopeReducing type
      index ← index.insert conclusion types.size
      types := types.push type
    let (_, _, pattern) ← forallMetaTelescopeReducing statement
    let candidates ← index.getUnify pattern
    let mut checked : Array Nat := #[]
    let mut instanceOf : Array Nat := #[]
    let mut covers : Array Nat := #[]
    for i in candidates.qsort (· < ·) do
      if checked.contains i then continue
      checked := checked.push i
      let type := types[i]!
      if (← isInstanceOf statement type) then instanceOf := instanceOf.push i
      if (← isInstanceOf type statement) then covers := covers.push i
    answer [("instanceOf", toJson instanceOf), ("covers", toJson covers)]

end SeshatMeta
