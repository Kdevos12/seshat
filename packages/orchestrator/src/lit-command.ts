import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Hit, LIT_MAX_LIMIT, type LitSearchOutput, shown } from "@seshat/lit";
import { CapabilityError, type FactoryContext, type HostProfile, loadHostProfile, hostProfilePath } from "@seshat/registry";
import { FACTORIES, openRegistry, REPO_ROOT } from "./implementations.ts";
import { enabledBackends } from "./lit-enabled.ts";
import { studentHost } from "./solve-command.ts";

export const PROBE_QUERY = "Graffiti conjecture independence number counterexample";
export const PROBE_LIMIT = 3;

export interface LitProbeOptions {
  host?: string;
  query?: string;
  limit?: number;
  out?: string;
  noCache?: boolean;
  /** The `config` directory; default: the repository's. */
  configDir?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

export interface LitProbeIo {
  out(line: string): void;
  err(line: string): void;
  signal?: AbortSignal;
}

/**
 * `harness lit probe`: one `lit.search` call for each backend the host enables, restricted to it, through the registry. It prints what
 * each site answered and what the parser made of it, and with `out` keeps the raw body and the parsed hits of each as files, so that a
 * real answer can become a test fixture. No model is called and no journal is written. Exit code: 0 when a backend returned hits.
 */
export async function litProbeCommand(o: LitProbeOptions, io: LitProbeIo): Promise<number> {
  const configDir = o.configDir ?? `${REPO_ROOT}config`;
  const host = studentHost(o.host, configDir);
  const profile = loadHostProfile(hostProfilePath(configDir, host));
  const ids = enabledBackends(profile, o.env ?? process.env);
  if (profile.capabilities["lit.search"] === undefined || ids.length === 0) {
    io.err(`the host profile ${host} enables no backend of lit.search: give one an address in config/hosts/${host}.json`);
    return 1;
  }
  const query = o.query ?? PROBE_QUERY;
  const limit = Math.min(o.limit ?? PROBE_LIMIT, LIT_MAX_LIMIT);
  // --no-cache: the same profile without its cache directory.
  const lit = FACTORIES.lit;
  const factories = lit === undefined ? FACTORIES : { ...FACTORIES, lit: (ctx: FactoryContext) => { const { cacheDir: _dropped, ...settings } = ctx.settings; return lit(o.noCache === true ? { ...ctx, settings } : ctx); } };
  const registry = openRegistry({ host, configDir, factories, ...(o.env !== undefined ? { env: o.env as Record<string, string> } : {}) });
  io.out(`host ${host}; query ${JSON.stringify(shown(query, 400))}; limit ${limit}; backends: ${ids.join(", ")}${o.noCache === true ? "; no cache" : ""}`);
  if (o.out !== undefined) mkdirSync(o.out, { recursive: true });
  let withHits = 0;
  try {
    for (const id of ids) {
      if (io.signal?.aborted === true) break;
      io.out(`\n${id}`);
      let result: LitSearchOutput | undefined;
      let failure: string | undefined;
      try {
        result = (await registry.invoke("lit.search", { query, limit, backends: [id], keepRaw: true }, io.signal === undefined ? {} : { signal: io.signal })).output as unknown as LitSearchOutput;
      } catch (error) {
        failure = error instanceof CapabilityError ? [error.message, ...error.details].join("; ") : error instanceof Error ? error.message : String(error);
      }
      const answer = result?.answers.find((a) => a.backend === id);
      if (result === undefined || answer === undefined || answer.error !== undefined) {
        io.out(`  error: ${shown(failure ?? answer?.error ?? "no answer", 500)}`);
        continue;
      }
      const hits: Hit[] = result.hits.filter((h) => h.backend === id);
      io.out(`  asked: ${shown(answer.url, 600)}`);
      io.out(`  answer: ${answer.cached === true ? "from the cache (HTTP 200 when it was fetched)" : "HTTP 200"}; ${hits.length} hit(s) parsed`);
      const first = hits[0];
      if (first !== undefined) {
        withHits++;
        io.out(`  first hit: ${shown(first.title, 300)}`);
        io.out(`    link: ${shown(first.url, 500)}`);
        io.out(`    text: ${shown(first.text, 200)}`);
      }
      if (o.out !== undefined) {
        writeFileSync(join(o.out, `${id}.raw.txt`), answer.raw ?? "");
        writeFileSync(join(o.out, `${id}.hits.json`), `${JSON.stringify(hits, null, 2)}\n`);
      }
    }
  } finally {
    await registry.close();
  }
  io.out(`\n${withHits} of ${ids.length} backend(s) returned hits.`);
  return withHits > 0 ? 0 : 1;
}
