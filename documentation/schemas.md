# Schemas: the shapes of closed decompositions

A schema is the shape of a decomposition that worked: a conclusion, the parts that imply it, and the main proof that put the parts
together, with variables where problems differ. ProofEvolve (arXiv 2608.26334) extracts them from closed sub-DAGs into a cross-problem
library and instantiates them at matching goals; line `M15` ([archive.md](archive.md)) does the same without training. The code is
`@seshat/scheduler` (`terms.ts`, `schemas.ts`); the node kind, its shape and its index are `@seshat/library` (`schemas.ts`), so a
schema lives in the library next to the lemmas ([library.md](library.md#schemas)) with an index of its own.

A schema is learned from an outcome, not from Lean. Its node is **stamped** with the run's provenance and enters probation on a new epoch
([memory.md](memory.md#provenance-and-epochs)); it reaches a prover only as advice, through the randomized inclusion
([memory.md](memory.md#randomized-inclusion)), and its measured effect decides whether it stays in use ([archive.md](archive.md#the-effect-of-a-schema)).
It never changes a claim's status: what a prover builds from it goes through `validate` like anything else.

## Token trees

Lean is not parsed here. A statement or a proof is read as a tree of tokens (`parseNodes`): identifiers (a dotted name is cut at its
dots and written back whole), numerals, symbols, and bracket groups `( ) [ ] { } ⟨ ⟩ ⦃ ⦄ ⟦ ⟧ ‹ › ⌊ ⌋ ⌈ ⌉`; each node keeps the whitespace
before it, so a tree is written back as it was read. Comments are dropped. A **variable** is written `?3` and stands for one token or
one bracketed group, or for the whole contents of a group or of a statement when it is alone there. That keeps precedence out of it: a variable is
never part of an infix expression, so `?1 + 0` matches `(a * b) + 0` and not `a * b + 0`, and a match never changes how a term parses.
The cost is that the schemas are first-order and shallow; `lean.meta` is what says whether a lexical match is a match
([below](#confirmation-by-leanmeta)).

## Making a schema

`skeletonOf({conclusion, parts, mainProof}, minSpecificity)` reads a closed decomposition:

1. Every text goes through the **strict screen** (`screenFormal`; Global Constraint 16). Statements and the main proof come from a
   model's sketch, and a schema is shown to provers of other problems: no comment (it could hold an instruction), no string, no control or
   direction character, no token the validator forbids, no `?` followed by a digit (the variable notation), at most 600 characters
   for a statement and 2000 for the proof.
2. The statements must be in signature form (`parseSignature`) and the brackets must match.
3. The names the claim binds (`(n m : ℕ)`) become the variables `?1`, `?2`... in the claim, the parts and the main proof, so they are the same
   variable throughout. The names a part binds that the claim does not are that part's **locals**: variables of their own, remembered with the
   name the source gave them (instantiation writes them back under it, and reuse matches them against whatever a hole calls them).
4. Variables are numbered by first appearance. The skeleton must have a share of fixed tokens of at least `minSpecificity` (0.5 by default),
   or it says too little to be a shape and is refused.

The stored node (`library_schema`) holds the skeletons as text (`(?1 : ℕ) : ?1 + 0 = ?1`), the hole names the main proof uses, the family of the
main proof (the strategy label of Task 2's classifier), the region (how many parts and the claim's main symbol, `2p:=`), the decompositions it was
made from, a state (`active`, `inactive`, `superseded`) and a name `schema_<family>_<six digits>` from the skeleton. A sketch whose
auxiliary region holds anything but the holes (a helper lemma proved in it) gives no schema: the helper is specific to its problem.

## Merging

A new skeleton is compared with the active schemas of the library that have the same number of parts, in the order they were made:

- an existing schema **covers** it when its skeleton matches the new one, the claim, each part in order and the main proof with one set of
  bindings: the new decomposition is another support of that schema (its `supports` grows) and nothing else is stored;
- otherwise, the first schema it can be **generalized** with (`generalize`) is: the claim, the parts and the main proof are anti-unified with
  one set of variables, and the result, if it keeps `minSpecificity`, is stored as a new schema that lists the ones it generalizes, which
  become `superseded` (the index leaves them out; the journal keeps them);
- otherwise it is stored as it is.

**Anti-unification** (`antiUnify`) is Plotkin's least general generalization, over tokens: what two statements share is kept, where they differ
a variable stands, and the same pair of subterms is the same variable. The tokens are aligned by a longest common subsequence; between two
aligned tokens the differing stretches must have the same length and are paired one position to one; a stretch longer on one side has no
variable that stands for one token or one group, so that level fails and the group that holds it becomes one variable. A statement
that cannot be generalized at its top level does not merge. This is the engine Ruling 20 asked Task 18 to write itself, now that Task 12 is
suspended; it is small on purpose, and it does not look inside a term.

## Instantiation

`instantiate(skeleton, names, goal)` matches the conclusion's skeleton against the goal's statement (`matchNodes`) and writes the parts and
the main proof with what the variables are bound to. A part that has a variable the goal does not determine (a number in which two sources
differed, that no conclusion mentions) makes the schema unusable at that goal. The result is a sketch for the goal: one hole
`lemma <name> <statement> := by sorry` for each part, and a main proof that names them.

### Confirmation by lean.meta

A lexical match is not a match. `confirm` asks `lean.meta` ([lean-meta.md](lean-meta.md)): the schema's conclusion is stated as a theorem with its variables
as binders (`generalStatement`: `(x1 : ℕ) : x1 + 0 = x1`; a variable that is not the claim's binder becomes `(x3 : _)`, with the type left to Lean) and
the `instances` operation says whether the goal is an instance of it. Only a schema that is confirmed is instantiated. A refusal by Lean or
no answer is "not confirmed", with the reason in the log, so the line fails closed; `confirm: false` is for a run without `lean.meta` and takes the
lexical match (the option's page says what that risks).

The parts of an instantiated schema are then compared with the facts Lean accepted (`lean.meta` `instances` again, as the scheduler's subsumption
does, [scheduler.md](scheduler.md)): a part that is an instance of an accepted fact is *covered* and the hint says so; the others are the
**leftover premises**, the subgoals the sketch leaves to prove.

## Reuse

`reuses(skeleton, claim, holes)` says whether a decomposition has the shape of a schema: the conclusion matches the claim and the parts match
the holes one to one under one set of bindings (a part's own binders match whatever the hole calls them). The line measures reuse with it,
whoever suggested the schema: a session reuses a schema when its sketch is an instance of it, whether the session was shown the schema, was denied
it by the draw, or was shown a random one ([archive.md](archive.md#measured)).

## Tested, and not yet

`packages/scheduler/test/terms.test.ts` and `schemas.test.ts` cover the reader and the writer (spacing, dotted names, brackets, comments), the head
of a statement, anti-unification (shared and differing parts, equal pairs, the length rule, the group fallback), matching and filling (variables
that bind groups and sequences, consistency, brackets around a stretch), the screen of each text, skeletons (shared and local variables,
specificity, the stored form), merging (cover, generalize, refuse), instantiation (binders, locals, shapes that do not fit, undetermined
variables, the statement sent to `lean.meta`) and reuse. **Not run:** the statement `generalStatement` writes has never been elaborated by a real Lean
(`(x3 : _)` binders and the `instances` operation on them are written against the documented contract of `lean.meta`); a refusal makes the line
leave the schema out, so the cost of being wrong is that no schema is confirmed, not a wrong one.
