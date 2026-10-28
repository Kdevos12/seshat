import { LINE_TITLES, type Line } from "@seshat/lines";
import { configClassOf } from "@seshat/core";
import { classifyFailure, classifyStrategy, premisesOf, renderTried, STRATEGIES, TextIdentity } from "@seshat/memory";

/** The most lines of the "already tried" section, when the run does not say (`--line-option M1.maxLines=...`). */
const MAX_LINES = 12;

/**
 * M1: canonical identity, shared negative memory (documentation/m1-identity-memory.md). The run's
 * claims are named by the statement's text, so two problems with one statement share a claim. Each
 * attempt is labeled with a strategy from a closed vocabulary, the names it uses, and what failed,
 * all computed from what it submitted and from Lean's messages. Every session starts with the
 * typed summaries of the attempts already made on the statement or an equivalent one, by any prover
 * of the run: what was tried and how it failed, never the text of an attempt.
 */
export const M1: Line = {
  id: "M1",
  title: LINE_TITLES.M1,
  requires: [],
  options: { maxLines: MAX_LINES },
  // Recorded in run.started: change it with the vocabulary, a classifier's rule or the section's format.
  version: "m1-2",
  // Everything M1 knows it reads from the memory (the claims and the attempts' typed summaries), so a
  // resumed process gives the same briefing: nothing is kept in the process.
  resume: "stateless",
  identity: () => new TextIdentity(),
  strategies: STRATEGIES,
  hooks: {
    briefing: async (session) => {
      const maxLines = typeof session.options.maxLines === "number" ? session.options.maxLines : MAX_LINES;
      // With the run's models ranked, a line from another model or budget class says so ("with a smaller model").
      const view =
        session.ranking === undefined
          ? undefined
          : { current: configClassOf({ modelId: session.model, budgetClass: session.ranking.budgetClass }), ranking: session.ranking };
      const lines = renderTried(session.memory.alreadyTried(session.claimId, view), { maxLines });
      return lines.length === 0 ? undefined : { title: "Already tried", text: lines.join("\n") };
    },
    afterAttempt: async (problem, attempt) => {
      // A session that checked nothing has nothing to classify.
      if (attempt.submission === undefined) return undefined;
      const { aux, proof } = attempt.submission;
      const premises = premisesOf({ aux, proof });
      const failure =
        attempt.outcome === "invalid" && attempt.report !== undefined
          ? classifyFailure(attempt.report, { statement: problem.target.statement, aux })
          : undefined;
      return {
        strategy: classifyStrategy({ aux, proof }),
        ...(premises.length > 0 ? { premises } : {}),
        ...(failure !== undefined ? { failureDetail: failure.detail } : {}),
      };
    },
  },
};
