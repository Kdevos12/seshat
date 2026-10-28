import type { DecideQuestion } from "@seshat/lines";
import { labelsOf } from "./question.ts";

export interface Answered {
  answer: string | number | boolean;
  probabilities: Record<string, number>;
  expected?: number;
}

/** The label a noul answer stands for. */
const yesNo = (answer: unknown): string | undefined => (answer === true || answer === "yes" ? "yes" : answer === false || answer === "no" ? "no" : undefined);

/**
 * A backend's answer made a distribution over exactly the question's labels: keys it does not know
 * are an error, missing labels get 0, and the whole is scaled to sum to 1. The answer must be one of
 * the labels; when the backend's distribution disagrees with its answer, the answer is kept and the
 * distribution as it is (both are journaled).
 */
export function normalize(question: DecideQuestion, answer: unknown, distribution: Record<string, unknown>): Answered {
  const labels = labelsOf(question);
  const label = question.type === "noul" ? yesNo(answer) : typeof answer === "string" ? answer : undefined;
  if (label === undefined || !labels.includes(label)) throw new Error(`the answer ${JSON.stringify(answer)} is not one of the question's labels`);
  let total = 0;
  const raw: Record<string, number> = {};
  for (const [key, value] of Object.entries(distribution)) {
    if (!labels.includes(key)) throw new Error(`the distribution has ${JSON.stringify(key)}, which is not one of the question's labels`);
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`the probability of ${key} is not a non-negative number`);
    raw[key] = value;
    total += value;
  }
  if (!(total > 0)) throw new Error("the distribution is empty or all zero");
  const probabilities = Object.fromEntries(labels.map((l) => [l, (raw[l] ?? 0) / total]));
  const result: Answered = { answer: question.type === "noul" ? label === "yes" : label, probabilities };
  if (question.type === "score") result.expected = expectedLevel(question.levels, probabilities);
  return result;
}

/** The expected level of a score as an index from 0, the number to order by. */
export function expectedLevel(levels: readonly string[], probabilities: Record<string, number>): number {
  return levels.reduce((sum, level, i) => sum + i * (probabilities[level] ?? 0), 0);
}

/** The most probable label; ties go to the earlier label. */
export function topLabel(labels: readonly string[], probabilities: Record<string, number>): string {
  let best = labels[0] as string;
  for (const label of labels) if ((probabilities[label] ?? 0) > (probabilities[best] ?? 0)) best = label;
  return best;
}
