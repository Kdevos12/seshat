import Lean

/-!
# Statements, and the commands' answers

A statement is written in the signature form of the harness's claims: the binders, then `:` and
the type, as between a theorem's name and its `:=` (`(n : ℕ) : n + 0 = n`, or `: 1 + 1 = 2`).
`elabStatement` elaborates it to the closed term `∀ binders, type`. Every `#seshat_*` command
prints its answer as one line of JSON, in an information message at the command.
-/

namespace SeshatMeta

open Lean Elab Meta

/-- Elaborates a statement in signature form to the closed term `∀ binders, type`.

Unlike a theorem's header, it binds no name automatically (no auto-bound implicits): every
variable must be bound by the binders, and a universe by a `universe` command of the file.
Universe metavariables become universe parameters. An elaboration error is an error of the
command, and a hole that Lean could not fill is refused. -/
def elabStatement (sig : Syntax) : TermElabM Expr := Term.withoutErrToSorry do
  let (binders, typeStx) := expandDeclSig sig
  let statement ← Term.elabBinders binders.getArgs fun xs => do
    let type ← Term.elabType typeStx
    Term.synthesizeSyntheticMVarsNoPostponing
    mkForallFVars xs type
  let statement ← Term.levelMVarToParam (← instantiateMVars statement)
  let statement ← instantiateMVars statement
  if statement.hasMVar then
    throwError "the statement has a hole that Lean could not fill"
  return statement

/-- Prints the command's answer: one line of JSON, in an information message. -/
def answer (fields : List (String × Json)) : TermElabM Unit :=
  logInfo m!"{(Json.mkObj fields).compress}"

/-- The instance-implicit parameters of a constant's type, in order: the position of each, and its
class (the head constant of its type, or `.anonymous` when the head is not a constant). -/
partial def instanceParams (type : Expr) (i : Nat := 0) (acc : Array (Nat × Name) := #[]) :
    Array (Nat × Name) :=
  match type with
  | .forallE _ domain body info =>
    let acc :=
      if info.isInstImplicit then
        acc.push (i, (domain.getForallBody.getAppFn.constName?).getD .anonymous)
      else
        acc
    instanceParams body (i + 1) acc
  | .mdata _ body => instanceParams body i acc
  | _ => acc

/-- The strings, sorted, without duplicates. -/
def sortedUnique (xs : Array String) : Array String :=
  (xs.qsort (· < ·)).foldl (init := #[]) fun acc x =>
    if acc.back? == some x then acc else acc.push x

end SeshatMeta
