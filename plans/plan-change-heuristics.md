# Plan change (proposed): a bank of heuristic cards

Status: approved by the owner on 2026-11-05 ("on construit ce système de banque d'heuristiques"), except HB5 item 4, which stays on hold. Proposed on 2026-11-05. On 2026-11-05 the owner asked to import heuristics from
more traditions than Pólya's (first principles thinking, VOTAT...): HB8 is added. Whether a model may
propose new cards from our logs (HB5 item 4) is left open by the owner (13:04): it is not built unless
Global Constraint 16 is amended. The owner also stated that a heuristic is a method of reasoning, not a
programmable tool: tools stay in the registry, and a card only names or prepares them. Every other item
fits the plan's current rules. Research note (French):
`research/banque-heuristiques.md`. Adds line `M19` and Task 32; amends Tasks 8/19 (fleet), 20 (decide), 26 (prompt optimization) and 27 (packs) additively.

## Why

The owner asked to separate heuristic skills from technical skills: a heuristic has a context of use, is
needed often but not always, can be scored, ranked, mutated, and its choice is mostly semantic. Seshat
already has the parts, scattered: 13 strategy labels and 6 diversity directives drawn by Thompson per claim
(`documentation/fleet.md`), counted lessons with a causal effect (M5), schemas (M15), human-written skills in
packs (Task 27), a `fleet.cold_start` prior from `decide`, and offline prompt optimization (Task 26). What
is missing: one object with a machine-checked context of use, learning that transfers across problems
(posteriors are per claim today), and an offline miner.

Evidence that sets the limits (details and links in the note): curated skills help and self-generated ones
do not (SkillsBench, arXiv 2602.12670: +16.2 vs -1.3 points; 4 or more skills +5.9 vs +18.6 for 2-3;
mathematics only +6.0); a 202-skill library loses up to 21% through wrong selection (arXiv 2605.24050);
agents copy retrieved experience and stored errors propagate unless a strict evaluator gates additions
(arXiv 2505.16067); an LLM choosing a method from descriptions does not beat the best fixed method on a
homogeneous task set (arXiv 2406.11698); covering more distinct approaches at a fixed sample budget gains 5
to 10 points on MATH and OlympiadBench (arXiv 2606.29985). So: small bank, one card per session, the
harness (not the model) assigns distinct cards across provers, Lean is the evaluator, and every card's
standing is its measured causal effect.

## HB1. The heuristic card

A declarative JSON record, `heuristic` node of the memory (or a file in a pack), validated by a schema in
`@seshat/core`:

| Field | Meaning |
|---|---|
| `id`, `version` | Stable name (`specialize.small_cases`) and version. |
| `family` | One move from a closed vocabulary, aligned with the 11 families of SHAPE (arXiv 2608.28600, drawn from Pólya, Schoenfeld and the didactics literature) and extended: `specialize`, `generalize`, `auxiliary`, `decompose`, `work_backwards`, `analogy`, `represent`, `restate`, `definitions`, `vary`, `compute`, `invariant`, `extremal`, `count`, `symmetry`, `contradiction`, `induction`, `counterexample`, `bounds`, `automation`, `look_back`. Maps onto M1's `STRATEGIES` (a table in the schema), so existing posteriors and failure memory keep their labels. A new family is a plan change, not a pack's choice. |
| `level` | Zeitz's levels `strategy` (an attitude) or `tactic` (a mathematical move). Zeitz's third level, `tool`, is not a card: tools are capabilities in the registry and the battery. |
| `tradition`, `source` | Free metadata declared by the pack: the tradition (`polya`, `first_principles`, `cps_votat`, `zeitz`, `engel`, `tao`, `experimental`, `triz`...) and a bibliographic reference. Never shown to the prover, never used to rank. |
| `ask` | One question to the prover, at most 160 characters, passing `screenProse` ("Can you compute the first ten cases and guess the pattern?"). A question, never an order or a recipe. |
| `when`, `whenNot` | Conjunctions over a closed vocabulary of features computed without a model: the problem's MSC domain prefix; goal features read from the statement or `lean.goals` (`forall_nat`, `exists`, `inequality`, `divisibility`, `prime`, `finset_sum`, `real`, `function_equation`, statement size class); history features (`last_failure_class`, `attempts_on_claim`, `depth_stuck`). Also, from `research/catalogue-heuristiques.md`: `claim_kind` (`prove`, `conjecture`, `determine`, `definition`, `construct`), `origin_informal` (the statement was formalized from natural language), `closed_fast` (accepted within the first attempt or below a token threshold), `informal_sketch` (an `nl_first` step DAG exists). Unknown features are refused. |
| `tools`, `prepare` | The capabilities that serve the method (named, for the prover's tool list), and optionally one capability call to make before the session, with arguments built from the goal (`compute.sage` small cases, a battery tactic set), whose result goes to the briefing as data. Level-2 trust rules of Task 27 apply; the result is evidence, never a status. |
| `expects` | What progress looks like (`subgoals`, `table`, `counterexample`, `lemma`, `closed`), used by the report and the miner. |
| `origin`, `parent`, `stamp` | `builtin` or `pack:<name>`; the card it was derived from; Task 23's provenance stamp and epoch. |

The 13 strategy labels and 6 directives are rewritten as built-in cards, with identical behaviour when M19
is off (a test checks that a run without M19 records the same `attempt.started` as today). Pack skills stay
for technical content; a pack may add cards under a `heuristics` key (Task 27, additive), and cards count
apart from the three-skill rule since only one card reaches a session.

## HB2. Selection: filter, bandit, prior

In the fleet's `beforeSession`, when M19 is on:

1. **Filter** the active cards by `when` / `whenNot` (deterministic, no cost).
2. **Thompson** over the families that have a card that passes, then over that family's cards, with Beta posteriors keyed by (card, context bucket), where the
   bucket is the domain prefix and at most two goal features, and the session model's config class (Task 23's model family): the same heuristic can help one model and hurt another (catalogue, D8). The config class sits under the family-pooled prior, so a model with few observations borrows from the others. Counts are shared across problems and carried
   by `--memory-from` (Ruling 28), weighted by epoch probation (Task 23). A card's posterior starts from its
   family's pooled counts (a hierarchical prior with a capped weight), so new cards are not blind. This is
   the mechanism of Task 6's (domain, tactic) Beta posteriors, not the withdrawn PD8 k-NN: no distances, no
   neighbours, only counts per bucket.
3. **No card** is an arm of its own, kept at a floor share (`noCardShare`, 0.2 by default).
4. **Distinct cards** for provers working on the same claim at the same time (draws without replacement
   by family first).
5. **Prior** where a bucket has no data: the existing `fleet.cold_start` site of `decide` (LLM by default,
   Jev optional) returns a distribution over families, added as capped pseudo-counts that fade as today.
   No `decide` call picks the session's card. Its privacy note (the statement goes to a third party with
   Jev) is unchanged.

The briefing section "Strategy for this session" carries the card's `ask` (and the `prepare` result, HB4).
The card id, the bucket and whether the draw included or withheld it are on `attempt.started`.

## HB3. Measure

A card's standing is its causal effect, using PE2's randomized inclusion and `itemEffect` of the memory
store: sessions that drew the card versus sessions in the same bucket that drew the no-card arm, weighted by
probation. Deactivation as for lessons (P(effect < 0) > 0.9 after `minObservations` per side). The report
gives, per family and per card, the two arms, the bucket counts and the cards deactivated. Effects are read
per family first: at a 30% base rate, a 10-point effect needs about 350 sessions per arm, so per-card
ranking is a long-run quantity, not a per-run one.

## HB4. A card names its tools; it is not one

A heuristic is a method of reasoning, not a tool (the owner, 2026-11-05). The card says where to look; the
tools that serve it stay capabilities of the registry. A card's `prepare` only spares the prover a call it
would make anyway (a table of small cases for `specialize`, the battery on a weakened statement for
`definitions`), at the cost of a tool call, not a model call. Its budget is charged through Task 29's gate
(`site: "heuristic.prepare"`, additive). A failed or unavailable
capability falls back to the `ask` alone and is logged.

## HB5. The offline miner: `harness heuristics mine RUN_DIR...` 

Outside every run, like `harness optimize-prompts`: it reads finished journals and never writes them. It
calls no model to write anything unless item 4 is approved.

1. **Statistics, no model.** Per (card, bucket): the effect and its interval; buckets where a card loses
   (proposal: add a `whenNot`), where it wins outside its `when` (proposal: widen), cards with no effect
   after enough observations (proposal: retire). Output: a patch to the bank and a report, applied only by
   `harness heuristics apply PATCH --as NAME` (journal entry by an actor `human:NAME`, like lesson
   decisions).
2. **Unexplained successes, no model.** Accepted proofs whose strategy label disagrees with the card drawn,
   grouped by bucket: listed for a person to read.
3. **Compliance.** Whether the session followed its card: the strategy label M1 gives the submission
   (`classifyStrategy`) against the card's family. A card nobody follows has no effect to measure; the
   report gives the rate per family. If the lexical label proves too coarse, an offline LLM annotator in
   the manner of SHAPE may label the family a trace used: a counted classification, like M1's, never a
   text that reaches a prover.
4. **Candidate cards proposed by a model: on hold, the owner's decision (left open on 2026-11-05).** Not
   built under Global Constraint 16 as it stands. If the owner amends it, one capped model call per group
   of item 2 writes a candidate in the HB1 format, screened by `screenProse`, `pending` and shown to nobody
   until `harness heuristics approve ID --as NAME`, then in probation (inclusion 0.5) and judged by HB3.
   The amendment would add to the constraint, after "or counted lessons": "or heuristic cards in the
   closed format of HB1 that a person approved one by one, which then carry the provenance stamp and are
   judged by their measured effect."

## HB5b. A harness hook, not a card: replay the battery after a new lemma

From the catalogue (D4, Feynman's habit as told by Rota): when a lemma is proved or promoted to the
library, try `apply` of that lemma followed by the battery on the open claims of the run in the same
domain. M12's backward subsumption already closes open holes that are instances of a new fact; this adds
the case where the lemma is a step, not an instance. Capped by Task 29's gate (`site: "heuristic.replay"`).

## HB6. Mutation

`when` / `whenNot` change only through HB5 item 1. The text of `ask` changes only through Task 26's
machinery (a new `PROMPT_TARGETS` entry for the built-in cards file, the strict screen, `harness ablate`,
and a human merge). No online evolution of cards.

## HB8. Heuristics from other traditions, imported by packs

Pólya is one source among many. A card from another tradition is written by a person, in their own words
(a question of at most 160 characters), with its `tradition` and `source`; it arrives in a pack (Task 27)
and falls under Global Constraint 16 as a human-written skill. Nothing extracts cards from a book or a web
page with a model (external text never enters a briefing, and the books are under copyright).

1. **Families bound the measure.** However many traditions are installed, cards are measured by family
   first (HB2, HB3): ten traditions that all say "try small cases" share one family's counts.
2. **Catalogue versus active bank.** The installed catalogue may hold hundreds of cards; the `when` filter
   and the family draw keep what a session can receive small. The cap `maxActive` applies to cards that
   pass the filter for a context, not to the catalogue.
3. **Overlap at install.** `harness add` reports two cards of one family whose `when` and `ask` overlap (a
   novelty check in the manner of Buffer of Thoughts); the person installing chooses. No automatic merge.
4. **A catalogue of candidates**, `research/catalogue-heuristiques.md` (45 heuristics beyond those listed below, 19 marked to do): the starter pack draws from it first those aimed at measured failures of models on research mathematics (a statement closed suspiciously fast, the intent of an informal statement, is it already known through a library or search capability, the hypotheses of a named lemma, strengthening the induction hypothesis, a toy model, a partial result).
5. **A starter pack** shipped with Seshat: today's 13 strategy labels and 6 directives as cards, and about
   25 cards from first principles thinking (`definitions`: unfold the definitions; which hypothesis is used,
   with a `prepare` that drops a hypothesis and reruns the battery), VOTAT from complex problem solving research
   (`vary`: one parameter at a time in a Sage table, then two for interactions; between two failed attempts
   change one thing; rerun unchanged to detect nondeterminism), Zeitz, Engel (`invariant`, `extremal`,
   `count`), Tao (`counterexample`: what would a counterexample look like), experimental mathematics
   (`compute`), and TRIZ as a tradition tag on cards of existing families only (segmentation, inversion,
   prior action, separation by condition), with no contradiction matrix. Schoenfeld's control, Lakatos
   (M14), strong inference (the prove/refute twin) are covered by existing mechanisms; lateral thinking
   and SCAMPER wait for a measure on conjecture generation (M13); fast-and-frugal heuristics belong to the
   harness's own control (Task 29), not to the bank.

## HB7. Guardrails and the ablation line M19

- One card per session (option `maxCards`, 1, at most 2); active bank at most 24 cards (`maxActive`); a
  card's text is a question of at most 160 characters.
- Line `M19` requires `M1` and `fleet`, placed after `fleet` in `LINE_ORDER`. It must beat `fleet` with the
  current strategy labels and directives at equal budget, measured in cost to first success on the bench's
  sequences (Task 14), or be removed (plan §6 rule).
- Trust: a card never changes a claim's status, never states a fact, and its text never comes from an
  external source (Global Constraint 16 as it stands).

## Cost if wrong

A bank that narrows exploration: bounded by the no-card floor and the distinct-card rule, and caught by
M19's ablation against `fleet`. Feature buckets too fine to gather counts: the family prior keeps them
usable; the bucket rule is an option. A card imported from a tradition that does not fit Lean-checked
mathematics: probation and effect-based deactivation; the cost is the sessions spent measuring it.

## Order

The owner asked on 2026-11-05 to build it before the first real run (Ruling 32). The proposal had set it after the first real run, and only if its data shows that today's directive or strategy posteriors
separate (a free check on a run with `--lines M1,fleet` and `directive: true`). Built by the main team;
additive on the shared packages `core` (the schema), `memory` (the node kind), `lines` (the id) and the
fleet.
