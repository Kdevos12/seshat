import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A server that stands in for OpenAlex, arXiv, Semantic Scholar and zbMATH, which this environment cannot reach. The shapes are
 * written by hand from their documentation as remembered, not recorded from the sites. A query with the word `collatz` gets one
 * hit on each; any other, none. `title` and `abstract` are what the hit says, so that a test can put hostile text there.
 */
export interface FakeLit {
  url: string;
  requests: string[];
  close(): Promise<void>;
}

export interface FakeLitOptions {
  title?: string;
  abstract?: string;
  /** Answers every request with a redirect to this address. */
  redirect?: string;
  /** Answers every request with a body this long, of type text/plain. */
  bodyBytes?: number;
  /** The content type of every answer. */
  type?: string;
  /** A link the sites give for the work. */
  link?: string;
}

export const ABSTRACT = "We prove that the conjecture is false: a counterexample exists for every odd modulus considered here.";
const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

export async function startFakeLit(options: FakeLitOptions = {}): Promise<FakeLit> {
  const requests: string[] = [];
  const title = options.title ?? "On the Collatz conjecture";
  const abstract = options.abstract ?? ABSTRACT;
  const link = options.link ?? "https://example.org/work/1";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fake.test");
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    if (options.redirect !== undefined) {
      response.statusCode = 302;
      response.setHeader("Location", options.redirect);
      response.end();
      return;
    }
    if (options.bodyBytes !== undefined) {
      response.setHeader("Content-Type", "text/plain");
      response.end("x".repeat(options.bodyBytes));
      return;
    }
    const q = (url.searchParams.get("search") ?? url.searchParams.get("search_query") ?? url.searchParams.get("query") ?? url.searchParams.get("search_string") ?? "").toLowerCase();
    const found = q.includes("collatz");
    const json = (body: unknown): void => {
      response.setHeader("Content-Type", options.type ?? "application/json");
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/works") {
      const index: Record<string, number[]> = {};
      abstract.split(" ").forEach((w, i) => (index[w] = [...(index[w] ?? []), i]));
      return json({ results: found ? [{ id: "https://openalex.org/W1", doi: link, title, abstract_inverted_index: index }] : [] });
    }
    if (url.pathname === "/graph/v1/paper/search") return json({ total: found ? 1 : 0, data: found ? [{ paperId: "p1", title, abstract, url: link }] : [] });
    if (url.pathname === "/v1/document/_search") return json({ result: found ? [{ id: 123, title: { title }, editorial_contributions: [{ text: abstract }], links: [{ url: link }] }] : [] });
    if (url.pathname === "/api/query") {
      response.setHeader("Content-Type", options.type ?? "application/atom+xml");
      response.end(
        `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${found ? `<entry><id>http://arxiv.org/abs/0000.00000v1</id><title>${xml(title)}</title><summary>${xml(abstract)}</summary></entry>` : ""}</feed>`,
      );
      return;
    }
    response.statusCode = 404;
    response.end("no");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
