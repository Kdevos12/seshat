# Heuristics: the bank of heuristic cards

A **heuristic** is a method of reasoning: it says where to look ("Can you solve a special case?"). It is
not a tool and never a fact. Tools stay capabilities of the registry ([capabilities.md](capabilities.md));
facts come from Lean. The bank of heuristic cards is the part of Seshat that holds these methods, gives one
to a session, and measures whether it helps. It is plan change HB1 to HB8
([plan-change-heuristics.md](../plans/plan-change-heuristics.md), research notes
`research/banque-heuristiques.md` and `research/catalogue-heuristiques.md` in the project's shared folder).

The code is `@seshat/heuristics` (the card format, the families, the features, the built-in cards, the
overlap check). The fleet draws the cards ([fleet.md](fleet.md#heuristic-cards)); packs add cards
([packs.md](packs.md#heuristic-cards)).

## One source for each thing

The bank does not add a second copy of anything Seshat already had:

| Concept | Where it lives | What the bank does with it |
|---|---|---|
| The six diversity directives (`small_cases`, `more_general`, `other_tool`, `shortest`, `skeleton`, `doubt`) | `DIRECTIVE_CARDS` here | They are cards. The fleet's `directives: true` reads their text from this package, word for word. |
| The strategy labels of M1 (`STRATEGIES`) | `@seshat/memory` | Unchanged. A tactic card's family maps to at most one label (`FAMILY_STRATEGY`), so a card never points a session away from the strategy the fleet chose. |
| Lessons (M5) | `@seshat/lessons` | Separate on purpose: a lesson is learned from the run's outcomes, a card is written by a person. |
| Schemas (M15), library lemmas (M3) | `@seshat/scheduler`, `@seshat/library` | Separate: verified procedure. A card may name the tools that reach them. |
| Skills of packs | `@seshat/registry` | Technical knowledge stays a skill; a method of reasoning is a card (`heuristics` in `pack.json`). |
| Tools (`compute.sage`, `lean.check`, the battery) | the registry | A card names the capabilities that serve its method (`tools`); it is not one of them. |

## What a card is

```json
{
  "id": "vary.one_parameter",
  "version": 1,
  "family": "vary",
  "level": "strategy",
  "ask": "Vary one parameter at a time in small cases, the others fixed: which one does the answer depend on, and how?",
  "when": { "anyFeatures": ["forall_nat", "finset_sum", "function_equation"] },
  "tools": ["compute.sage"],
  "expects": "table",
  "tradition": "cps_votat",
  "source": "VOTAT, vary one thing at a time: Tschirgi (1980); Vollmeyer, Burns and Holyoak (1996)"
}
```

| Field | Meaning |
|---|---|
| `id`, `version` | Stable name, lowercase words joined by `_`, in at most three parts joined by `.`; a version from 1. |
| `family` | One of the closed list below. Cards are measured by family first. |
| `level` | `strategy` (an attitude: how to work) or `tactic` (a mathematical move). Zeitz's third level, the tool, is not a card. |
| `ask` | What the prover reads: one line, at most 160 characters, a question or a short directive, with no link, markup, code or invisible character. |
| `when`, `whenNot` | When the card applies, over the context below; `whenNot` excludes. Optional. |
| `tools` | Capability ids that serve the method, named for the prover. Optional. |
| `expects` | What progress looks like: `subgoals`, `table`, `counterexample`, `lemma`, `witness` or `closed`. For the report. |
| `tradition`, `source` | Where the method comes from (`polya`, `first_principles`, `cps_votat`, `zeitz`, `engel`, `tao`, `experimental`, `strong_inference`, `schoenfeld`, `lakatos`...), and a reference. Never shown to the prover, never used to rank. |

`cardProblems(value)` lists what is wrong with a card; `parseCard` throws with all of it. A field the
format does not know is refused, and so is a `whenNot` that is an empty object (the card would never
apply).

### Families

`specialize`, `generalize`, `auxiliary`, `decompose`, `work_backwards`, `analogy`, `represent`,
`restate`, `simplify`, `definitions`, `vary`, `compute`, `invariant`, `extremal`, `count`, `symmetry`,
`contradiction`, `induction`, `counterexample`, `bounds`, `automation`, `look_back`.

They follow the families of SHAPE (arXiv 2608.28600, drawn from Pólya, Schoenfeld and the didactics of
mathematics), with the moves of other traditions added: `definitions` (first principles thinking),
`vary` (VOTAT, from research on complex problem solving), `invariant`, `extremal` and `count` (Engel).
The list is closed: a new family is a change of the plan, not a pack's choice. Ten traditions that all say
"try small cases" are ten cards of one family, and share its counts.

`FAMILY_STRATEGY` maps the families that are moves of one of M1's labels: `compute` to `computation`,
`induction`, `decompose` to `cases`, `contradiction`, `automation`, `counterexample`, `generalize` to
`generalization`, `bounds`, and `extremal` and `count` to `extremal`. `strategyOfCard` gives the label of a
tactic card; a strategy card, or a family without a label, is neutral.

## The context a `when` reads

Everything a condition reads is computed without a model:

| Condition | Holds when |
|---|---|
| `domains` | the problem has a domain starting with one of these (`msc:05`, `msc:11B`) |
| `features` | the statement has all of these features |
| `anyFeatures` | it has at least one of these |
| `minAttempts`, `maxAttempts` | the counted attempts on the claim (or the subgoal) are within these bounds |
| `lastFailure` | the last counted attempt failed with one of these failure classes ([m1-identity-memory.md](m1-identity-memory.md)) |
| `minDepthStuck` | at least this many counted attempts since Lean last got further (the depth ladder of `@seshat/memory`) |
| `modes` | the session runs in one of these modes (`standard`, `nl_first`) |

Every field given must hold. `statementFeatures(statement)` reads the features from the statement's text:
`forall_nat` (a natural number bound by the signature or by `∀`), `exists`, `inequality` (arrows are not
comparisons), `divisibility`, `prime`, `finset_sum` (a finite sum, product or cardinality), `real`,
`function_equation` (a function variable between number types), and one size class (`size_small` under
80 characters, `size_medium` under 240, `size_large`). They are lexical: an unusual notation can fool them,
so a card that keys on them is filtered, not proved applicable. `historyOf(attempts)` gives the counts.

`bucketOf(domains, features)` is the bucket a session's counts are kept under across problems: the first
domain's two digits and the first two features, size left out (`msc:11|forall_nat+divisibility`). It is
coarse on purpose, so that a bucket gathers enough sessions to say something.

## The built-in cards

`BUILTIN_CARDS` holds the six directives (`DIRECTIVE_CARDS`, all strategy cards with no condition, as
before the bank) and 23 starter cards (`STARTER_CARDS`) from nine traditions: first principles thinking
(unfold the definitions; which hypothesis is used), VOTAT (one parameter at a time; one change between two
failed checks), strong inference (the discriminating computation), experimental mathematics (guess the
answer first), Pólya (restate the intent; a known result; working backwards; strengthen the induction
hypothesis; the hypotheses a named lemma needs), Engel (invariants, the extremal object, counting two ways,
the equality case), Zeitz (normalize by symmetry), Tao (dominant terms, the deferred witness, a toy model,
the weakest version, where a counterexample would be, what one would look like) and Schoenfeld (name the
obstacle before switching). Each is written in our own words; none quotes a book. A test checks that every
built-in card is valid, that no two overlap, and that M6's framing check finds nothing in any of them (none
asks to demonstrate the statement).

## Overlaps

`overlaps(cards)` reports two cards of one family whose questions share at least 40% of their content words
(Jaccard over lowercase words of three letters or more, without stop words), or have the same text. Cards
of different families are never reported: they are measured apart. `checkBank(cards)` adds the errors: an
invalid card, or an id taken twice (a pack may not reuse a built-in id or another pack's). `bankOf(packs)`
is the bank a run draws from, the built-in cards then the packs' cards, each with its `origin` (`builtin`
or `pack:<name>`); a bank with an error is refused. Overlaps are reported, never merged: the person who
installs a pack chooses.

## Trust

A card never changes a claim's status, never states a fact and never reaches a system prompt. Built-in
cards are written by the project; pack cards by the pack's author (Global Constraint 16: human-written).
Nothing in Seshat writes a card from a run's outcomes: whether a model may propose cards for a person to
approve is a question the owner has left open (plan change HB5, item 4), and it is not built.

## Tested, and not yet

`packages/heuristics/test` covers the card check (every refusal), the built-in bank (valid, no overlap,
the directives word for word), the statement features, the history counts, the bucket, the conditions and
the overlaps; `packages/guards/test/framing.test.ts` checks that M6's framing check finds nothing in a
built-in card (there, so that this package does not depend on the guards, which depend on the registry,
which reads pack cards with this package); `packages/registry/test/packs.test.ts` covers a pack's cards. Not run: any measure of whether a card helps a real model.
