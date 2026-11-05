import type { Fetch } from "../src/index.ts";

export interface SeenRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface WireQuestion {
  type: "choice" | "score" | "noul";
  criteria?: Record<string, string> | string[] | { true: string; false: string };
}

/**
 * A fake Jev server speaking TypeSafe's System One protocol (the body OpenRouter's Decisions endpoint takes too): it answers
 * each question with 0.7 on the last label and the rest evenly on the others, a score's probabilities keyed by level position
 * with a `legend`, a noul's probability of yes at 0.3, and usage with tokens and a cost of $0.00013. `respond` replaces the answer.
 */
export function fakeJev(respond?: (request: SeenRequest) => Response | Promise<Response>): { fetch: Fetch; seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  const answer: Fetch = async (input, init) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const request: SeenRequest = { url: String(input), headers, body: JSON.parse(String(init?.body)) as Record<string, unknown> };
    seen.push(request);
    if (respond !== undefined) return await respond(request);
    const questions = request.body.questions as Record<string, WireQuestion>;
    const answers = Object.fromEntries(
      Object.entries(questions).map(([name, q]) => {
        if (q.type === "noul") return [name, { type: "noul", noul: 0.3 }];
        const labels = q.type === "choice" ? Object.keys(q.criteria as object) : (q.criteria as string[]).map((_, i) => String(i));
        const top = labels[labels.length - 1] as string;
        const rest = labels.length === 1 ? 0 : 0.3 / (labels.length - 1);
        const probabilities = Object.fromEntries(labels.map((l) => [l, l === top ? 0.7 : rest]));
        if (q.type === "choice") return [name, { type: "choice", choice: top, probabilities, confidence: 0.6 }];
        const legend = Object.fromEntries((q.criteria as string[]).map((level, i) => [String(i), level]));
        const score = labels.reduce((sum, l) => sum + Number(l) * (probabilities[l] ?? 0), 0);
        return [name, { type: "score", score, probabilities, legend, confidence: 0.5 }];
      }),
    );
    return Response.json({ id: "dec_fake", model: request.body.model, answers, usage: { input_tokens: 120, output_tokens: 3, cost: 0.00013 } });
  };
  return { fetch: answer, seen };
}
