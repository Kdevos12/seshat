import Lean

/-!
# SeshatCertify

The Lean side of the capability `lean.certify` (documentation/certifier.md). The harness compiles
the reference file and the candidate file to `.olean` files with `lake env lean -o`, then runs

    lake env lean --run Main.lean request.json

in the Lean project of the bench. This program runs none of the candidate's code: it reads the two
`.olean` files as data, and

1. sends every declaration of the candidate's module to the kernel (`Lean.Environment.replay`, as
   lean4checker does), so that nothing in the module is believed because the elaborator said so;
2. looks the target up in that checked environment and compares what it states with what the
   reference states, as terms and not as text (the approach of SafeVerify): the target's type, and
   everything the module declares that the type depends on, with its value when it is a definition;
3. collects the target's axioms itself (`CollectAxioms`) and refuses any outside the allowed set.

The request is a JSON file
`{"reference": "<.olean>", "candidate": "<.olean>", "target": "Ns.name", "allowedAxioms": ["propext", ...]}`.
The answer is one line of JSON on stdout, `{"verdict": "certified" | "rejected", "reasons": [...],
"axioms": [...]}`, with exit code 0. A failure that is not the candidate's (a request that does not
parse, a reference that cannot be replayed) prints nothing on stdout and exits with another code.

This program has never been compiled: it was written against the sources of Lean v4.27.0 (and of
lean4checker and SafeVerify) in an environment without Lean. `lake build` in this directory is the
first thing to run with a Lean toolchain.
-/

open Lean

namespace SeshatCertify

/-- What the harness asks: the two compiled files, the theorem to certify and the axioms it may use. -/
structure CertifyRequest where
  reference : System.FilePath
  candidate : System.FilePath
  target : Name
  allowedAxioms : Array Name

def CertifyRequest.parse (text : String) : Except String CertifyRequest := do
  let json ← Json.parse text
  let field (key : String) : Except String String := do
    (← json.getObjVal? key).getStr?
  let reference ← field "reference"
  let candidate ← field "candidate"
  let target ← field "target"
  let axioms ← (← json.getObjVal? "allowedAxioms").getArr?
  let axioms ← axioms.mapM (fun a => a.getStr?)
  return {
    reference := ⟨reference⟩
    candidate := ⟨candidate⟩
    target := target.toName
    allowedAxioms := axioms.map String.toName
  }

/-- A compiled module: what its `.olean` holds, and the constants it declares itself, by name. -/
structure CompiledModule where
  data : ModuleData
  own : Std.HashMap Name ConstantInfo

def loadModule (file : System.FilePath) : IO CompiledModule := do
  unless (← file.pathExists) do
    throw <| IO.userError s!"the object file {file} does not exist"
  let (data, _) ← readModuleData file
  let mut own : Std.HashMap Name ConstantInfo := {}
  for name in data.constNames, info in data.constants do
    own := own.insert name info
  return { data := data, own := own }

/-- The answer: the candidate is certified when there is no reason against it. -/
structure Outcome where
  reasons : Array String := #[]
  axioms : Array Name := #[]

def refuse (reason : String) : Outcome :=
  { reasons := #[reason] }

def Outcome.toJson (o : Outcome) : Json :=
  Json.mkObj [
    ("verdict", Json.str (if o.reasons.isEmpty then "certified" else "rejected")),
    ("reasons", Lean.toJson o.reasons),
    ("axioms", Lean.toJson (o.axioms.map toString))
  ]

/-- The module's declarations, each sent to the kernel; the kernel's exception is the reason. -/
def replayModule (base : Environment) (m : CompiledModule) : IO Environment := do
  try
    base.replay m.own
  catch e =>
    throw <| IO.userError s!"the kernel refused the module: {e}"

/--
What the meaning of a constant rests on, one step down. A definition or an opaque constant is its
type and its value. A theorem is its type only: what it states does not depend on its proof.
-/
def usedBy (info : ConstantInfo) : Array Name :=
  match info with
  | .defnInfo v => v.type.getUsedConstants ++ v.value.getUsedConstants
  | .opaqueInfo v => v.type.getUsedConstants ++ v.value.getUsedConstants
  | .inductInfo v => v.type.getUsedConstants ++ v.ctors.toArray
  | .ctorInfo v => v.type.getUsedConstants.push v.induct
  | other => other.type.getUsedConstants

/--
The constants a module declares itself that the statement of `target` rests on: the target, what its
type mentions, what those mention, and so on. Constants of the imports are not followed, since the
two modules have the same imports.
-/
def statementClosure (own : Std.HashMap Name ConstantInfo) (env : Environment) (target : Name) : Array Name :=
  Id.run do
    let mut seen : NameSet := {}
    let mut todo : Array Name := #[target]
    let mut found : Array Name := #[]
    while !todo.isEmpty do
      let name := todo.back!
      todo := todo.pop
      if seen.contains name then
        continue
      seen := seen.insert name
      if !own.contains name then
        continue
      found := found.push name
      match env.find? name with
      | some info => todo := todo ++ usedBy info
      | none => pure ()
    return found

/--
Whether two constants say the same thing. A theorem is compared by name, universe parameters and
type, never by proof (the candidate's proof is the point). A definition is compared by its value too,
and by its safety, since the type mentions it by name only. This follows `equivThm`, `equivDefn` and
`equivOpaq` of SafeVerify.
-/
def sameStatement (a b : ConstantInfo) : Bool :=
  match a, b with
  | .thmInfo x, .thmInfo y =>
    x.name == y.name && x.levelParams == y.levelParams && x.type == y.type && x.all == y.all
  | .defnInfo x, .defnInfo y =>
    x.name == y.name && x.levelParams == y.levelParams && x.type == y.type && x.value == y.value
      && x.safety == y.safety && x.all == y.all
  | .opaqueInfo x, .opaqueInfo y => x == y
  | .axiomInfo x, .axiomInfo y => x == y
  | .ctorInfo x, .ctorInfo y => x == y
  | .recInfo x, .recInfo y => x == y
  | .quotInfo x, .quotInfo y => x.name == y.name && x.levelParams == y.levelParams && x.type == y.type
  | .inductInfo x, .inductInfo y =>
    x.name == y.name && x.levelParams == y.levelParams && x.type == y.type
      && x.numParams == y.numParams && x.numIndices == y.numIndices && x.all == y.all
      && x.ctors == y.ctors && x.numNested == y.numNested && x.isRec == y.isRec
      && x.isUnsafe == y.isUnsafe && x.isReflexive == y.isReflexive
  | _, _ => false

/-- The axioms a constant depends on, found in the kernel environment as `#print axioms` does. -/
def axiomsOf (env : Environment) (name : Name) : Array Name := Id.run do
  let (_, state) := ((CollectAxioms.collect name).run env).run {}
  return state.axioms

/-- The candidate against the reference. What fails here is the candidate's: it is the reason. -/
def judge (req : CertifyRequest) (reference : CompiledModule) (base refEnv : Environment) : IO Outcome := do
  let candidate ← loadModule req.candidate
  let sameImports := candidate.data.imports.map (fun i => i.module) == reference.data.imports.map (fun i => i.module)
  unless sameImports && candidate.data.isModule == reference.data.isModule do
    return refuse "the candidate imports other modules than the reference"
  for name in candidate.data.constNames, info in candidate.data.constants do
    if info.isUnsafe then
      return refuse s!"the module declares the unsafe constant {name}"
    if info.isPartial then
      return refuse s!"the module declares the partial constant {name}"
  let env ← replayModule base candidate
  unless candidate.own.contains req.target do
    return refuse s!"the candidate does not declare {req.target}"
  let mut reasons : Array String := #[]
  for name in statementClosure reference.own refEnv req.target do
    match refEnv.find? name, env.find? name with
    | some expected, some given =>
      unless sameStatement expected given do
        if name == req.target then
          reasons := reasons.push s!"{name} does not state what the reference states"
        else
          reasons := reasons.push s!"{name}, which the statement depends on, is not the reference's"
    | some _, none =>
      reasons := reasons.push s!"{name}, which the statement depends on, is missing"
    | none, _ => pure ()
  let found := axiomsOf env req.target
  let outside := found.filter (fun a => !req.allowedAxioms.contains a)
  unless outside.isEmpty do
    reasons := reasons.push s!"{req.target} depends on axioms that are not allowed: {outside.toList}"
  return { reasons := reasons, axioms := found }

/--
Replays the reference (what fails there is not the candidate's doing, and is an exception), then
judges the candidate against it. The two modules have the same imports, so they are imported once.
-/
def certify (req : CertifyRequest) : IO Outcome := do
  let reference ← loadModule req.reference
  let base ← importModules reference.data.imports {} 0
  let refEnv ← replayModule base reference
  match refEnv.find? req.target with
  | some (.thmInfo _) => pure ()
  | some _ => throw <| IO.userError s!"{req.target} is not a theorem in the reference"
  | none => throw <| IO.userError s!"the reference does not declare {req.target}"
  try
    judge req reference base refEnv
  catch e =>
    return refuse s!"{e}"

end SeshatCertify

open SeshatCertify

def main (args : List String) : IO UInt32 := do
  match args with
  | [requestFile] =>
    try
      initSearchPath (← findSysroot)
      let text ← IO.FS.readFile requestFile
      match CertifyRequest.parse text with
      | .error message => throw <| IO.userError s!"the request does not parse: {message}"
      | .ok req =>
        let outcome ← certify req
        IO.println outcome.toJson.compress
        return 0
    catch e =>
      IO.eprintln s!"seshat-certify: {e}"
      return 1
  | _ =>
    IO.eprintln "usage: lean --run Main.lean <request.json>"
    return 2
