import type { Json } from "@seshat/core";
import { checkSchema, type JsonSchema, validate } from "@seshat/registry";
import type { JsonRequest, JsonResult, Llm, LlmRequest, LlmResult } from "./line.ts";

/**
 * The model's answer to `completeJson` did not match the schema, or was not JSON, even after the
 * retry. Both calls were made and charged; `modelCallIds` names them.
 */
export class JsonAnswerError extends Error {
  /** What was wrong with each answer, the first one's first. */
  readonly problems: readonly string[][];
  /** The `model_call.finished` events of the calls made, in order. */
  readonly modelCallIds: readonly string[];
  /** The text of the last answer. */
  readonly text: string;

  constructor(message: string, details: { problems: string[][]; modelCallIds: string[]; text: string }) {
    super(message);
    this.problems = details.problems;
    this.modelCallIds = details.modelCallIds;
    this.text = details.text;
  }
}

/** The JSON in a model's answer: the answer itself, the first fenced block, or the outermost object or array. */
export function parseJsonAnswer(text: string): { ok: true; value: Json } | { ok: false; error: string } {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];
  const fenced = /```(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)```/.exec(trimmed);
  if (fenced?.[1] !== undefined) candidates.push(fenced[1].trim());
  const first = trimmed.search(/[{[]/);
  if (first >= 0) {
    const close = trimmed[first] === "{" ? "}" : "]";
    const last = trimmed.lastIndexOf(close);
    if (last > first) candidates.push(trimmed.slice(first, last + 1));
  }
  let error = "the answer is empty";
  for (const candidate of candidates) {
    if (candidate === "") continue;
    try {
      return { ok: true, value: JSON.parse(candidate) as Json };
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }
  return { ok: false, error: `the answer is not JSON: ${error}` };
}

const MAX_PROBLEMS_SHOWN = 8;
const MAX_ANSWER_SHOWN = 2000;

function instruction(schema: JsonSchema): string {
  return (
    "Answer with a single JSON value that matches this JSON Schema, and nothing else: no prose before or after it.\n" +
    JSON.stringify(schema)
  );
}

function listed(problems: readonly string[]): string {
  const shown = problems.slice(0, MAX_PROBLEMS_SHOWN).join("; ");
  return problems.length > MAX_PROBLEMS_SHOWN ? `${shown}; and ${problems.length - MAX_PROBLEMS_SHOWN} more` : shown;
}

function check(schema: JsonSchema, text: string): { value: Json } | { problems: string[] } {
  const parsed = parseJsonAnswer(text);
  if (!parsed.ok) return { problems: [parsed.error] };
  const problems = validate(schema, parsed.value);
  return problems.length === 0 ? { value: parsed.value } : { problems };
}

function sum(a: LlmResult["cost"], b: LlmResult["cost"]): LlmResult["cost"] {
  return { usd: a.usd + b.usd, inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

/**
 * Builds an `Llm` from its `complete`: `completeJson` asks for an answer that matches a schema
 * (`JsonSchema` of `@seshat/registry`, the subset manifests use), checks it, and on an answer that
 * is not JSON or does not match asks once more, telling the model what was wrong. A second failure
 * throws `JsonAnswerError`. Each call goes through `complete`, so each is charged to the problem's
 * budget and recorded like any other call, with the same site. A call that fails (the budget is
 * spent, the model errs) is not retried here; the error goes up as it is.
 */
export function withJson(complete: Llm["complete"]): Llm & Required<Pick<Llm, "completeJson">> {
  return {
    complete,
    completeJson: async <T = Json>(request: JsonRequest): Promise<JsonResult<T>> => {
      const { schema, ...rest } = request;
      const flaws = checkSchema(schema);
      if (flaws.length > 0) throw new Error(`completeJson: the schema is not usable: ${flaws.join("; ")}`);
      const prompt = `${rest.prompt}\n\n${instruction(schema)}`;
      const first = await complete({ ...rest, prompt });
      const firstCheck = check(schema, first.text);
      if ("value" in firstCheck) {
        return { value: firstCheck.value as T, text: first.text, cost: first.cost, model: first.model, modelCallId: first.modelCallId, modelCallIds: [first.modelCallId] };
      }
      const again: LlmRequest = {
        ...rest,
        prompt:
          `${prompt}\n\nYour previous answer was:\n${first.text.slice(0, MAX_ANSWER_SHOWN)}\n\n` +
          `It was refused: ${listed(firstCheck.problems)}.\nAnswer again with a single JSON value that matches the schema.`,
      };
      const second = await complete(again);
      const secondCheck = check(schema, second.text);
      const modelCallIds = [first.modelCallId, second.modelCallId];
      if ("value" in secondCheck) {
        return {
          value: secondCheck.value as T,
          text: second.text,
          cost: sum(first.cost, second.cost),
          model: second.model,
          modelCallId: second.modelCallId,
          modelCallIds,
        };
      }
      throw new JsonAnswerError(
        `the model's answer does not match the schema, after a retry: ${listed(secondCheck.problems)} ` +
          `(first answer: ${listed(firstCheck.problems)}; calls ${modelCallIds.join(", ")})`,
        { problems: [firstCheck.problems, secondCheck.problems], modelCallIds, text: second.text },
      );
    },
  };
}

/**
 * A call whose answer is JSON of a given shape, on any `Llm`: the one a line calls. It uses the
 * `Llm`'s own `completeJson` when it has one, and otherwise asks through `withJson` over its
 * `complete`, with the same single retry, so that each call is charged and recorded like any other.
 * An `Llm` written before `completeJson` existed (a test double, a wrapper) needs nothing added.
 */
export function completeJson<T = Json>(llm: Llm, request: JsonRequest): Promise<JsonResult<T>> {
  if (llm.completeJson !== undefined) return llm.completeJson<T>(request);
  return withJson((r) => llm.complete(r)).completeJson<T>(request);
}
