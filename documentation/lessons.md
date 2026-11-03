# Lessons (line M5)

Line `M5` ([lines.md](lines.md)) keeps short pieces of advice learned from the run's own outcomes, shows a few of them to each
session, and drops the ones that do not help. It is `M5` in `@seshat/lessons`; a run enables it with `harness run --lines M1,M5`
(it requires M1, which classifies each attempt's strategy and failure). When it is on it replaces the prose notes the model writes
for its next session ([m0-loop.md](m0-loop.md)); when it is off, nothing changes.

The design is ACE's incremental playbook (arXiv 2510.04618): entries are added, duplicates merged and nothing is ever rewritten,
because a rewrite loses detail. Two things are different from ACE and the plan's first version. A lesson's standing is its causal
effect, measured by withholding it at random from some sessions (PE2), not its presence in a session that happened to succeed. And a
lesson is unverified advice (Global Constraint 16): it is stamped with the run's provenance, its text comes only from journaled
outcomes, it is never shown as a fact or as the goal, and it changes no claim's status. Whether lessons help on this harness is not
known; the report ([Measured](#measured)) is how a run says.

## What a lesson is

A `lesson` node of the memory ([memory.md](memory.md)), recorded `learned`, so it carries the provenance stamp and its epoch
([memory.md](memory.md#provenance-and-epochs)). Its `data`:

| Field | Meaning |
|---|---|
| `text` | One or two sentences, at most 240 characters, fixed when the lesson is added. |
| `type` | `strategy` (an approach that worked) or `constraint` (a failure that recurs). |
| `scope`, `scopeKey` | `global` (every problem), `domain` (the problem's first domain, `msc:11`), or `claim` (one claim and the claims equivalent to it). |
| `strategy` | The label it is about, from `STRATEGIES`. |
| `key` | What makes two lessons duplicates: type, scope and what they say. |
| `origin` | `outcome`: the text is a template over the outcomes. `distilled`: one model call put a recurring failure in a line. |
| `support`, `claims`, `domains` | The attempts it rests on, their claims and domains (the latest 50). |
| `useful`, `harmful` | The presence counters ([Counters](#counters-and-deactivation)). |
| `active`, `pending`, `deactivated`, `widenedFrom` | Its state, and where it comes from. |

A lesson is never deleted or rewritten. A duplicate adds its support to the older entry. The only later changes are deltas
(`node.updated`): the counters, the merged support, `active` going false with the rule and the reason, and `widenedFrom`.

## How lessons are added

**From an accepted proof (strategy).** When a session's proof is accepted by the fast check, the strategy label of its submission
(`classifyStrategy`, the label M1 records) gives a domain lesson: "A proof using the induction strategy passed the fast check on msc:11 problems; try
that strategy early." The same strategy in `globalMinDomains` domains (2) and on `globalMinClaims` claims (3) widens to a global
lesson. The label `other` teaches nothing. "Accepted" is the fast check; the certifier has not replayed the proof yet, and the lesson
says no more than that.

**From failures that recur (constraint, PC3).** At the end of a problem, the failed attempts of every claim are grouped by failure
class and normalized detail (`unsolved_goals` with `unsolved goals at case succ`). A group with at least `minAttempts` attempts (3)
across at least two claims becomes a global constraint; on one claim it becomes a claim lesson, until another claim shows the same
failure, when a global constraint covers it and the claim lesson is deactivated (`widened`). A failure of the classes `refused`,
`lean_unavailable` and `other`, or with no detail, is not a lesson. One model call (`completeJson`, the site `lessons.distill`, at
most `maxDistill` per problem, charged to the problem's budget) puts the group in one line such as "Nat subtraction truncates: state
bounds before subtracting"; the prompt holds the failure class, the detail and up to three statements, and asks for nothing the
failures do not show. When the call fails, or `distill` is off, a template is the text: "The check rejected 4 attempts on 2 claim(s) the
same way (unsolved goals: ...); check for it before you submit." Either way the lesson lists the attempts it rests on.

**Screened text.** Every lesson text passes the strict screen of `@seshat/memory` (`screenProse`: one line, at most 240 characters, no code,
forbidden Lean token, link, declaration name or instruction) inside `addLesson`, whoever wrote it. The model's line is screened and falls
back to the template when refused; the template quotes Lean's own detail, so it is screened too, and a failure whose detail does not pass
(an error that names a lemma) is not made a lesson at all and no model is asked about it.

## What the provers see

In `beforeSession`, M5 first deactivates the lessons that have worn out, then takes the active lessons in scope (global, the problem's
domains, the problem's claim and its equivalents), the most promising first, at most `maxLessons` (3; SkillsBench found two or
three skills gain and four or more do not; see [Choosing which](#choosing-which)), and **draws** them (`session.draw`, [memory.md](memory.md#randomized-inclusion)): each
unverified lesson is included with probability 0.5 while it is new and 0.9 once it is established, and the ids drawn and withheld
are on `attempt.started`. The briefing section "Lessons" lists the lessons the draw included, each with its scope, under a sentence
that says the advice is not proved and may be wrong. A lesson is never offered as a fact and the goal is never drawn.

### Choosing which

The slots go to the lessons with the best measured effect, not the best presence counters, which credit a lesson for every success it was
merely shown in and would let the first lessons to succeed crowd out the rest. A lesson's score is its effect (the success rate of the
attempts that had it minus that of the attempts that were denied it, in its strategy label, each outcome weighed by its epoch's probation)
plus an exploration bonus `1 / sqrt(w + 1)`, where `w` is the weight of the observations of the arm that had it. A new lesson, or one whose
evidence is old, has a large bonus and is offered, so that it gathers the observations the deactivation rule needs; the draw then keeps
the comparison causal. The presence counters are not used to rank.

## Counters and deactivation

Two measures run side by side.

- **Presence counters** (the plan's first version, kept for comparison). After each attempt, a lesson that was shown to it gains a
  `useful` point when the attempt was accepted, and loses one (`harmful`) when the attempt failed on the lesson's strategy, or on any
  strategy for a lesson with none. A session that was cut says nothing. These credit a lesson that was shown to a success it did not
  cause, so a lesson shown often gains points and never leaves; they are in the report, not the default rule.
- **Effect** (PE2, the default). `itemEffect` of the memory store compares the attempts whose draw included the lesson with those whose
  draw withheld it, in the lesson's strategy label, as two Beta posteriors, with each outcome weighed by the probation of its epoch.
  The lesson is deactivated when P(effect < 0) is above `threshold` (0.9) after at least `minObservations` (8) observations on each
  side. An old lesson from an earlier epoch has little weight, so it must earn its place again.

`deactivation: "presence"` uses the presence rule instead: harmful outweighs useful after `minObservations` in all. A deactivated lesson
stays in the journal with the rule and the reason, and is never shown again; nothing reactivates it.

## Staged promotion (`--human`)

A lesson for the global scope changes what every later problem sees. In a consortium run (`--human`, or a turn limit; the line reads
`ProblemContext.human`) it is recorded `pending` and shown to nobody until the team answers (PE6 item 4). `globalPromotion` says how:
`human` (the default) stages in a consortium run and applies directly otherwise, `staged` always stages, `direct` never stages, `off`
makes no global lesson.

```
harness lessons pending RUN_DIR            # the lessons that wait, with their ids
harness lessons approve RUN_DIR ID [--as NAME] [--note TEXT]
harness lessons reject RUN_DIR ID [--as NAME] [--note TEXT]
```

Like `harness hint`, they write to the journal of a run no process holds, under the person's name: a `lesson_decision` node with
`provenance: "human"`. The next session after the run resumes sees an approved lesson (a draw may still withhold it, and its effect
is judged like any other); a rejected lesson stays in the journal and is never shown. Only a pending lesson can be answered. No answer
changes a claim's status.

## Measured

The report ([m0-loop.md](m0-loop.md#the-report)) has a paragraph and a `lessons` object: the lessons by state (active, deactivated,
waiting for the team, rejected), and for each lesson the presence counters next to the accepted attempts among those whose draw
included it and among those whose draw withheld it. The difference between the two arms is the measure; the counters are there to
show how far presence and effect disagree.

## Options

| Option | Default | Meaning |
|---|---|---|
| `maxLessons` | 3 | Lessons offered to a session (before the draw). |
| `deactivation` | `effect` | `effect` or `presence`. |
| `minObservations`, `threshold` | 8, 0.9 | The deactivation rule. |
| `fromSuccess`, `fromFailures` | true, true | Learn strategy lessons and constraints. |
| `minAttempts` | 3 | Attempts of a recurring failure. |
| `distill`, `maxDistill` | true, 2 | The model call that puts a failure in a line, and its cap per problem. |
| `globalPromotion` | `human` | `human`, `staged`, `direct` or `off`. |
| `globalMinDomains`, `globalMinClaims` | 2, 3 | What widens a strategy lesson to the global scope. |
| `replaceNotes` | true | The model's notes are not passed to its next session. |

## Tested, and not yet

`packages/lessons/test` covers: adding and merging (a duplicate leaves the text and counters alone), the stamp, strategy lessons and their
widening to the global scope (staged, direct, off), the grouping of failures, constraints distilled, templated and capped, the widening of a claim
constraint, the selection by scope and standing, the counters, deactivation by effect on scripted outcomes (and an item presence alone would drop
that stays), by presence, the staged states and the answers; and whole runs with the simulated model and Lean: a lesson learned from a
proof, drawn into the next problem and shown exactly when included, the counters, the notes not passed on (and passed on when asked), the
report, a constraint distilled at the site `lessons.distill`, and a lesson staged in a consortium run and answered with the commands. Not
run: a real model's distillation or use of a lesson, an effect measured over enough sessions to deactivate anything (the scripted tests do), the
packet of Task 11 (M4), which will carry the active lessons in its prefix, and any measure of whether lessons help.
