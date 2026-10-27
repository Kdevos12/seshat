import { LINE_TITLES } from "@seshat/lines";
import type { AttemptAnnotation, Briefing, CheckDecision, CheckVeto, JsonObject, Line, ProblemContext, Proposal, SessionContext } from "@seshat/lines";
import { classifyFailure, classifyStrategy, type LeanState, leanState } from "@seshat/memory";
import { type CitationEnv, knownSorries, unresolvedReferences } from "./citations.ts";
import { DEFAULT_WATCH, type Finding, type Observation, ProverWatch, SessionWatch } from "./detectors.ts";
import { type DriftData, recordDrift } from "./drift.ts";
import { categoryOf, framingProblems, isOpenConjecture, neutralQuestion } from "./framing.ts";
import { scrubLeanOutput } from "./rawerrors.ts";
import { type LastCheck, lastCheckOf, revisionProblem } from "./revisions.ts";
import { auxDeclarations, clip, codeSize, leanPassages } from "./text.ts";

/** Replaces the lines of the notes that cite something that resolves to nothing known. */
export const UNSOURCED_MARK = "[unsourced reference removed]";

/** What a run gives M6 that the base does not have yet: each is a function a later task provides. */
export interface M6Env {
  /**
   * Whether an auxiliary lemma's statement is nearly equivalent to the target's, both in signature
   * form. The Lean meta tool will answer this; without it, only M1's `restates_target` (a lemma that
   * states the target again after normalization) is found.
   */
  nearEquivalent?: (lemma: string, target: string) => boolean | Promise<boolean>;
  /** Whether a name is a declaration the project knows, such as a Mathlib lemma: a reference that resolves. */
  declarationExists?: (name: string) => boolean | Promise<boolean>;
  /** The short ids the session's context packet shows the prover (`C17`, `L4`), which M4 builds. */
  packetIds?: (session: SessionContext) => Iterable<string> | Promise<Iterable<string>>;
}

/**
 * The options of M6, with their defaults (`--line-option M6.repeats=...`). The five switches are
 * for ablation inside the line: each guard can be turned off alone.
 */
export const M6_OPTIONS = {
  /** Add the neutral question ("determine whether") to a problem that is an open conjecture. */
  framing: true,
  /** Add it to every problem, a solved one included (for experiments). */
  framingAll: false,
  /** Reject a check that cites what does not resolve, or presents a `sorry` as known. */
  citations: true,
  /** Take Lean's raw output out of the briefing sections and out of the notes. */
  rawErrors: true,
  /** Reject a check that is not a revision of anything Lean said. */
  revisions: true,
  /** Stop a session that loops, restates the target, drifts from it or grows without progress. */
  detectors: true,
  /** `strategy_loop`: checks in a row with one strategy and no Lean progress. */
  repeats: DEFAULT_WATCH.repeats,
  /** `session_loop`: sessions of one prover in a row with one strategy and no Lean progress. */
  sessionRepeats: 3,
  /** `length_growth`: the file's code this many times its size at the last progress... */
  lengthFactor: DEFAULT_WATCH.lengthFactor,
  /** ...and at least this many characters longer. */
  lengthMinChars: DEFAULT_WATCH.lengthMinChars,
} satisfies JsonObject;

const OWN_TITLES = ["The question", "Course change"];

function flag(options: Readonly<JsonObject>, key: keyof typeof M6_OPTIONS): boolean {
  const value = options[key];
  return typeof value === "boolean" ? value : (M6_OPTIONS[key] as boolean);
}

function count(options: Readonly<JsonObject>, key: keyof typeof M6_OPTIONS): number {
  const value = options[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : (M6_OPTIONS[key] as number);
}

interface SessionState {
  watch: SessionWatch;
  /** `lean_check` calls run in the session. */
  checks: number;
  last?: LastCheck;
  /** The strategy label of the last check. */
  label?: string;
}

interface ProverState {
  watch: ProverWatch;
  last?: LastCheck;
  /** What the prover's next session is told, once. */
  notices: string[];
}

/** What M6 keeps for one run. The line is one object for every run, so its state is the run's. */
interface RunState {
  sessions: Map<string, SessionState>;
  provers: Map<string, ProverState>;
  /** Framing findings already recorded, by problem and section. */
  noted: Set<string>;
  /** The answers of `nearEquivalent`, by lemma and target. */
  near: Map<string, boolean>;
}

const RUNS = new WeakMap<object, RunState>();

function runState(registry: object): RunState {
  let state = RUNS.get(registry);
  if (state === undefined) {
    state = { sessions: new Map(), provers: new Map(), noted: new Set(), near: new Map() };
    RUNS.set(registry, state);
  }
  return state;
}

function proverState(run: RunState, problemId: string, prover: string): ProverState {
  const key = `${problemId}/${prover}`;
  let state = run.provers.get(key);
  if (state === undefined) {
    state = { watch: new ProverWatch(), notices: [] };
    run.provers.set(key, state);
  }
  return state;
}

function sessionState(run: RunState, session: SessionContext): SessionState {
  let state = run.sessions.get(session.attemptId);
  if (state === undefined) {
    const options = session.options;
    state = {
      watch: new SessionWatch({ repeats: count(options, "repeats"), lengthFactor: count(options, "lengthFactor"), lengthMinChars: count(options, "lengthMinChars") }),
      checks: 0,
    };
    run.sessions.set(session.attemptId, state);
  }
  return state;
}

/** Where a finding came from, for the `drift` node. */
function whereOf(session: { attemptId: string; prover: string; session: number }, check?: number): Pick<DriftData, "attemptId" | "prover" | "session" | "check"> {
  return { attemptId: session.attemptId, prover: session.prover, session: session.session, ...(check !== undefined ? { check } : {}) };
}

function listOf(items: readonly string[], max = 4): string {
  const shown = items.slice(0, max).join(", ");
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

/**
 * M6: guards against hallucination, and drift detectors (plan §9, documentation/guards.md). All of
 * them deterministic; each finding is a `drift` node of the claim, and none changes a claim's status.
 *
 * - Neutral framing: an open conjecture gets "determine whether", never "prove that".
 * - Resolved citations: a reference in a `lean_check` must name an id of the packet or the graph, or
 *   resolve to a `source` node, or the call is rejected; a `sorry` presented as a known result is
 *   rejected even when the citation resolves.
 * - No raw error text: Lean's output is taken out of the briefing sections and out of the notes.
 * - Anchored revisions: a file sent again unchanged, or revised after a check that never reached
 *   Lean, is rejected.
 * - Drift detectors: a session is stopped, and the prover restarts it with a typed notice, when the
 *   same strategy is tried N times with no Lean progress, when the file proves a statement that is
 *   not the target, when an auxiliary lemma restates the target, or when the file grows with no
 *   subgoal closed. Across sessions, N sessions with one strategy and no progress clear the notes.
 */
export function createM6(env: M6Env = {}): Line {
  async function citationEnv(session: SessionContext): Promise<CitationEnv> {
    const packetIds = env.packetIds === undefined ? undefined : await env.packetIds(session);
    return {
      memory: session.memory,
      ...(packetIds !== undefined ? { packetIds } : {}),
      ...(env.declarationExists !== undefined ? { declarationExists: env.declarationExists } : {}),
    };
  }

  /** The auxiliary lemma that restates the target: M1's class, else the injected predicate. */
  async function restatingLemma(session: SessionContext, aux: string, failureClass: string | undefined, detail: string | undefined, run: RunState): Promise<Observation["restating"]> {
    if (failureClass === "restates_target") {
      const name = /^auxiliary lemma (\S+) restates the target/.exec(detail ?? "")?.[1];
      return { via: "restates_target", ...(name !== undefined ? { name } : {}) };
    }
    if (env.nearEquivalent === undefined) return undefined;
    const target = session.target.statement;
    for (const declaration of auxDeclarations(aux)) {
      if (declaration.statement === undefined) continue;
      const key = `${declaration.statement}\u0000${target}`;
      let near = run.near.get(key);
      if (near === undefined) {
        near = await env.nearEquivalent(declaration.statement, target);
        run.near.set(key, near);
      }
      if (near) return { via: "predicate", name: declaration.name };
    }
    return undefined;
  }

  return {
    id: "M6",
    title: LINE_TITLES.M6,
    requires: [],
    options: M6_OPTIONS,
    // Recorded in run.started: change it with a guard's rule, a detector's threshold or a notice's wording.
    version: "m6-1",
    // The detectors' counts across a prover's sessions, the notices waiting for its next session and the framing findings already made live in the process.
    resume: { refuse: "the detectors' counts across a prover's sessions, the notices waiting for its next session and the findings it has already recorded are kept in the process, and the journal cannot give them back" },
    hooks: {
      briefing: async (session): Promise<Briefing | undefined> => {
        const options = session.options;
        const paragraphs: string[] = [];
        let title = "";
        const category = categoryOf(session.target.sketch.header);
        const open = isOpenConjecture(category);
        if (flag(options, "framing") && (open || flag(options, "framingAll"))) {
          paragraphs.push(neutralQuestion({ known: !open }));
          title = "The question";
        }
        const prover = runState(session.registry).provers.get(`${session.problemId}/${session.prover}`);
        if (prover !== undefined && prover.notices.length > 0) {
          paragraphs.push(...prover.notices.splice(0));
          if (title === "") title = "Course change";
        }
        return paragraphs.length === 0 ? undefined : { title, text: paragraphs.join("\n\n") };
      },

      reviewBriefing: async (session, sections): Promise<Briefing[] | undefined> => {
        const options = session.options;
        const run = runState(session.registry);
        const category = categoryOf(session.target.sketch.header);
        const framed = flag(options, "framing") && (isOpenConjecture(category) || flag(options, "framingAll"));
        let changed = false;
        const kept: Briefing[] = [];
        for (const section of sections) {
          let text = section.text;
          if (flag(options, "rawErrors")) {
            const scrubbed = scrubLeanOutput(text);
            if (scrubbed.blocks > 0) {
              changed = true;
              const dropped = scrubbed.empty;
              recordDrift(session.memory, session.claimId, {
                kind: "raw_error_text",
                action: dropped ? "dropped_section" : "removed_text",
                detail: dropped ? "a briefing section was only Lean output and was dropped" : `${scrubbed.blocks} block(s) of Lean output removed from a briefing section`,
                ...whereOf(session),
                evidence: { section: clip(section.title, 60), blocks: scrubbed.blocks },
              });
              if (dropped) continue;
              text = scrubbed.text;
            }
          }
          if (framed && !OWN_TITLES.includes(section.title)) {
            const problems = framingProblems(section.text);
            const key = `${session.problemId}/${section.title}`;
            if (problems.length > 0 && !run.noted.has(key)) {
              run.noted.add(key);
              recordDrift(session.memory, session.claimId, {
                kind: "non_neutral_framing",
                action: "noted",
                detail: "a briefing section asks to prove a statement that is an open conjecture",
                ...whereOf(session),
                evidence: { section: clip(section.title, 60), phrases: problems },
              });
            }
          }
          kept.push(text === section.text ? section : { ...section, text });
        }
        return changed ? kept : undefined;
      },

      beforeCheck: async (session, proposal: Proposal): Promise<CheckVeto | undefined> => {
        const options = session.options;
        const run = runState(session.registry);
        const state = sessionState(run, session);
        const prover = proverState(run, session.problemId, session.prover);
        const where = whereOf(session, state.checks + 1);

        if (flag(options, "revisions")) {
          const problem = revisionProblem(state.last ?? prover.last, proposal);
          if (problem !== undefined) {
            recordDrift(session.memory, session.claimId, {
              kind: "unanchored_revision",
              action: "rejected_call",
              detail: problem.kind === "identical" ? "the file sent is the one last checked" : "a revision after a check that never reached Lean",
              ...where,
              evidence: { reason: problem.kind },
            });
            return { reject: problem.message };
          }
        }

        if (flag(options, "citations")) {
          const passages = [...leanPassages(proposal.aux), ...leanPassages(proposal.proof)];
          const unresolved = await unresolvedReferences(passages, await citationEnv(session));
          const sorries = [...new Set([...knownSorries(proposal.aux), ...knownSorries(proposal.proof)])];
          const reasons: string[] = [];
          if (unresolved.length > 0) {
            recordDrift(session.memory, session.claimId, {
              kind: "unresolved_citation",
              action: "rejected_call",
              detail: `${unresolved.length} reference(s) resolve to nothing known`,
              ...where,
              evidence: { references: unresolved.slice(0, 10) },
            });
            reasons.push(
              `The file refers to ${listOf(unresolved)}, and that resolves to no id of your packet or of the graph and to no source the harness knows. ` +
                "Cite only ids you were given or sources the harness knows, as [cite: ID]; otherwise remove the reference and prove the step yourself.",
            );
          }
          if (sorries.length > 0) {
            recordDrift(session.memory, session.claimId, {
              kind: "sorry_as_known",
              action: "rejected_call",
              detail: `${sorries.length} sorry presented as a known result`,
              ...where,
              evidence: { declarations: sorries.slice(0, 10) },
            });
            reasons.push(
              `A sorry in ${listOf(sorries)} is presented as a known result in a comment. A sorry is an open goal, not a result: ` +
                "prove it, or remove the claim that it is known.",
            );
          }
          if (reasons.length > 0) return { reject: reasons.join(" ") };
        }
        return undefined;
      },

      afterCheck: async (session, check): Promise<CheckDecision | undefined> => {
        const options = session.options;
        const run = runState(session.registry);
        const state = sessionState(run, session);
        const { aux } = check.submission;
        const statement = session.target.statement;
        const failure = classifyFailure(check.report, { aux, statement });
        const label = check.strategy ?? classifyStrategy(check.submission);
        state.checks = check.index;
        state.last = lastCheckOf(check.submission, check.report);
        state.label = label;
        if (!flag(options, "detectors")) return undefined;

        const restating = check.accepted ? undefined : await restatingLemma(session, aux, failure?.class, failure?.detail, run);
        const finding = state.watch.observe({
          index: check.index,
          label,
          state: leanState(check.report, { aux, statement }),
          size: codeSize(check.submission),
          ...(failure !== undefined ? { failureClass: failure.class } : {}),
          accepted: check.accepted,
          ...(restating !== undefined ? { restating } : {}),
        });
        if (finding === undefined) return undefined;
        recordDrift(session.memory, session.claimId, { kind: finding.kind, action: "stopped_session", detail: finding.detail, ...whereOf(session, check.index), evidence: finding.evidence });
        proverState(run, session.problemId, session.prover).notices.push(finding.notice);
        return { stop: finding.detail };
      },

      afterAttempt: async (problem: ProblemContext, attempt): Promise<AttemptAnnotation | undefined> => {
        const options = problem.options;
        const run = runState(problem.registry);
        const prover = proverState(run, problem.problemId, attempt.prover);
        const state = run.sessions.get(attempt.attemptId);
        run.sessions.delete(attempt.attemptId);
        const where = whereOf(attempt);
        const annotation: AttemptAnnotation = {};

        if (attempt.submission !== undefined && attempt.report !== undefined) prover.last = lastCheckOf(attempt.submission, attempt.report);

        // The same strategy, session after session, with Lean no further: the prover starts afresh.
        const best: LeanState | undefined = state?.watch.best;
        if (flag(options, "detectors") && best !== undefined && state?.label !== undefined) {
          const finding: Finding | undefined = prover.watch.observe(state.label, best, count(options, "sessionRepeats"));
          if (finding !== undefined) {
            recordDrift(problem.memory, problem.claimId, { kind: finding.kind, action: "restarted", detail: finding.detail, ...where, evidence: finding.evidence });
            prover.notices.push(finding.notice);
            annotation.notes = "";
          }
        }

        if (attempt.notes !== undefined && annotation.notes === undefined) {
          let notes = attempt.notes;
          if (flag(options, "rawErrors")) {
            const scrubbed = scrubLeanOutput(notes, { fences: true });
            if (scrubbed.blocks > 0) {
              recordDrift(problem.memory, problem.claimId, {
                kind: "raw_error_text",
                action: "removed_text",
                detail: `${scrubbed.blocks} block(s) of Lean output removed from the notes`,
                ...where,
                evidence: { blocks: scrubbed.blocks },
              });
              notes = scrubbed.empty ? "" : scrubbed.text;
            }
          }
          if (flag(options, "citations") && notes !== "") {
            const lines = notes.split("\n");
            const env2: CitationEnv = {
              memory: problem.memory,
              ...(env.declarationExists !== undefined ? { declarationExists: env.declarationExists } : {}),
            };
            const bad = new Set<number>();
            const references: string[] = [];
            for (const [k, line] of lines.entries()) {
              const unresolved = await unresolvedReferences([line], env2);
              if (unresolved.length > 0) {
                bad.add(k);
                references.push(...unresolved);
              }
            }
            if (bad.size > 0) {
              recordDrift(problem.memory, problem.claimId, {
                kind: "unresolved_citation",
                action: "removed_text",
                detail: `${bad.size} line(s) of the notes cite what resolves to nothing known`,
                ...where,
                evidence: { references: [...new Set(references)].slice(0, 10) },
              });
              const kept: string[] = [];
              for (const [k, line] of lines.entries()) {
                if (!bad.has(k)) kept.push(line);
                else if (kept[kept.length - 1] !== UNSOURCED_MARK) kept.push(UNSOURCED_MARK);
              }
              notes = kept.join("\n");
            }
          }
          if (notes !== attempt.notes) annotation.notes = notes.replace(/\s+/g, "") === "" ? "" : notes;
        }
        return annotation.notes !== undefined ? annotation : undefined;
      },

      afterProver: async (problem, end) => {
        runState(problem.registry).provers.delete(`${problem.problemId}/${end.prover}`);
      },
    },
  };
}

/** M6 with no injected predicate: a lemma that restates the target is found, and a reference resolves through the graph and `source` nodes. */
export const M6: Line = createM6();
