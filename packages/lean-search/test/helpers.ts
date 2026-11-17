import type { LeanCheckResult, LeanChecker, LeanMessage, LeanSnippet, ValidationReport } from "@seshat/core";
import type { Fetch } from "../src/index.ts";

/** A Lean that knows some names: `#check NAME` prints `SIGNATURE` at the line, an unknown name is an error there. It records each snippet. */
export class NamesLean implements LeanChecker {
  readonly implementation = "names-lean";
  readonly version = "0";
  readonly calls: LeanSnippet[] = [];
  readonly #known: Record<string, string>;
  readonly #failure: "timeout" | "server_error" | "throw" | undefined;

  constructor(known: Record<string, string>, failure?: "timeout" | "server_error" | "throw") {
    this.#known = known;
    this.#failure = failure;
  }

  async check(snippets: readonly LeanSnippet[]): Promise<LeanCheckResult[]> {
    const failure = this.#failure;
    if (failure === "throw") throw new Error("Lean is down");
    return snippets.map((snippet): LeanCheckResult => {
      this.calls.push(snippet);
      if (failure !== undefined) return { id: snippet.id, status: failure, messages: [], sorries: [], timeMs: 1, error: failure };
      const messages: LeanMessage[] = [];
      snippet.code.split("\n").forEach((line, k) => {
        const name = /^#check (\S+)$/.exec(line)?.[1];
        if (name === undefined) return;
        const signature = this.#known[name];
        messages.push(
          signature === undefined
            ? { severity: "error", pos: { line: k + 1, column: 7 }, text: `unknown identifier '${name}'` }
            : { severity: "info", pos: { line: k + 1, column: 0 }, text: signature },
        );
      });
      return { id: snippet.id, status: messages.some((m) => m.severity === "error") ? "lean_error" : "valid", messages, sorries: [], timeMs: 1 };
    });
  }
}

/** The report of a check that failed with the given messages and holes. */
export function reportOf(options: { unknown?: string[]; goals?: string[]; imports?: string[] }): ValidationReport {
  const imports = options.imports ?? ["import Mathlib"];
  const checked = [...imports, "", "theorem t : True := by", "  sorry", ""].join("\n");
  return {
    verdict: "invalid",
    method: "repl",
    reasons: [],
    axioms: [],
    messages: (options.unknown ?? []).map((name, k) => ({ severity: "error" as const, pos: { line: 5 + k, column: 2 }, text: `unknown identifier '${name}'` })),
    sorries: (options.goals ?? []).map((goal, k) => ({ pos: { line: 10 + k, column: 2 }, goal })),
    checked,
    submissionHash: "h",
    editsOutsideRegions: false,
    holes: (options.goals ?? []).length > 0,
    leanStatus: "lean_error",
  };
}

/** A fetch that answers from a function and records every request. */
export function fakeService(answer: (url: URL, init: RequestInit) => Response | Promise<Response>): { fetch: Fetch; requests: Array<{ url: string; method: string; body: string | undefined }> } {
  const requests: Array<{ url: string; method: string; body: string | undefined }> = [];
  const fetchFake: Fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push({ url: url.href, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
    return await answer(url, init ?? {});
  };
  return { fetch: fetchFake, requests };
}

export const json = (value: unknown, init: ResponseInit = {}): Response => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" }, ...init });
