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
| The effect of an item and its deactivation (PE2, M5's rule) | `@seshat/memory` (`effectOf`, `shouldDeactivate`) | Reused as it is: a card's effect is its sessions against the bucket's control, and the same rule deactivates it ([below](#statistics)). |
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

## Statistics

The bank is measured, never trusted: whether a card helps is what Lean accepted, set against the sessions
that got no card. There is one effect counter in Seshat, PE2's (`effectOf`, `armOf` and `shouldDeactivate`
of `@seshat/memory`, [memory.md](memory.md#randomized-inclusion)), and the bank uses it; as in PE2, only a
proof Lean accepted or a failed check says something, and a session that was cut is left out.

`heuristicStats(sessions, bank)` reads the sessions whose settings record a draw (`heuristic`,
`heuristicRule`, `heuristicFamily`, `heuristicBucket`, written by the fleet,
[fleet.md](fleet.md#heuristic-cards)) and gives, for each family, each card, and each card in each bucket:

- the sessions given it and how many were `valid`;
- the **control of its buckets**: the sessions of the same buckets that drew no card (`heuristicRule`
  `control`), and how many were `valid`. A card is never set against the run's average, because the
  fleet draws by bucket and buckets differ in difficulty; a session no card applied to
  (`none_applicable`) is not the control and is counted apart;
- the **effect**: PE2's two Beta posteriors, their difference and P(effect < 0), and whether M5's rule
  deactivates it (8 observations on each side, P(effect < 0) above 0.9); the fleet applies the same rule
  per bucket before it draws (option `cardMinObservations`);
- for a tactic card whose family maps to a strategy label, **compliance**: of its sessions M1 classified,
  how many went the card's way (`strategy` equal to the card's label). A card nobody follows measures
  nothing.

It also lists the **unexplained successes** (HB5 item 2): accepted proofs of sessions given a tactic card
whose classified strategy is not the card's, for a person to read. A line with fewer than 10 sessions, or
10 control sessions, says that it is too few to read: at a 30% base rate, a 10-point effect needs about
350 sessions per arm. No model is called anywhere here. The run's report has one paragraph (by family) when
a session recorded a draw (`heuristicReport(events)`, `report.json` field `heuristics`).

```sh
pnpm harness heuristics list [--packs-dir DIR]         # the bank a run draws from, and the overlaps in it
pnpm harness heuristics stats RUN_DIR                  # by family and by card, the unexplained successes
pnpm harness heuristics mine RUN_DIR... [--out FILE]   # the proposals of several finished runs
```

**The miner** (`bankProposals`, HB5 item 1) reads finished runs and writes nothing to them. It proposes
to **retire** a card deactivated across its buckets; to add a **`whenNot`** for a bucket where a card is
deactivated while it is not elsewhere; and marks a card with **no effect** after four times the minimum of
observations on each side (P(effect < 0) between 0.4 and 0.6). A proposal changes nothing. Since cards are
static files (Ruling 32), a person applies one by editing the card: a built-in card through a reviewed
commit, a pack's through a new version of the pack (`harness add --replace`). That review is the approval
the plan change gives to `harness heuristics apply`, which is therefore not a command; it would need the
bank's state in a journal of its own, which nothing else needs. "Wins outside its `when`" cannot be
observed, since a card is drawn only where its `when` holds.

`harness ablate --experiment heuristics` runs the fleet alone, with the six directives, and with the bank,
on the same problems at the same budget ([ablate.md](ablate.md#experiments)).

Not built (Ruling 32): a card's `prepare` step (HB4, site `heuristic.prepare` of the gate), the replay of
the battery after a new lemma (HB5b, site `heuristic.replay`), and the extra features `claim_kind`,
`origin_informal`, `closed_fast` and `informal_sketch`.

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
