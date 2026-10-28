import type { Fetch } from "../src/index.ts";

export interface SeenRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * A fake Jev server: answers each decision with a distribution that puts 0.7 on the last label and the
 * rest evenly on the others, at a cost of $0.00013, in the shape the client reads. `respond` replaces the answer.
 */
export function fakeJev(respond?: (request: SeenRequest) => Response | Promise<Response>): { fetch: Fetch; seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  const answer: Fetch = async (input, init) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const request: SeenRequest = { url: String(input), headers, body: JSON.parse(String(init?.body)) as Record<string, unknown> };
    seen.push(request);
    if (respond !== undefined) return await respond(request);
    const body = request.body;
    const labels =
      body.type === "choice" ? Object.keys(body.options as object) : body.type === "score" ? (body.levels as string[]) : ["yes", "no"];
    const top = labels[labels.length - 1] as string;
    const rest = labels.length === 1 ? 0 : 0.3 / (labels.length - 1);
    const distribution = Object.fromEntries(labels.map((l) => [l, l === top ? 0.7 : rest]));
    return Response.json({ id: "dec_fake", model: body.model, answer: top, distribution, usage: { prompt_tokens: 120, cost: 0.00013 } });
  };
  return { fetch: answer, seen };
}
