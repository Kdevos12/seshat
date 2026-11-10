import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Json } from "@seshat/core";
import { Fetcher, type FetcherOptions, LitError, refusalOf } from "./http.ts";
import { clean } from "./text.ts";

/**
 * The backends of `lit.search`: OpenAlex, arXiv, Semantic Scholar, zbMATH, and the metadata of a local bench checkout. Each takes
 * one query and gives hits: a title, a link, and the text the site gave (an abstract, a review, a docstring). That text is what a
 * quote is looked up in. None ran against its site (this environment cannot reach them): the requests and the answers are written
 * from the documentation of each as remembered, and the tests answer from a fake server.
 */
export const BACKENDS = ["openalex", "arxiv", "semantic-scholar", "zbmath", "bench-metadata"] as const;
export type BackendId = (typeof BACKENDS)[number];

export interface Hit {
  backend: BackendId;
  /** A link to the work: https, or `file:` for the local checkout. */
  url: string;
  title: string;
  /** The text the backend gave, cleaned and bounded: the only text a quote may come from. */
  text: string;
}

export interface Searched {
  /** The request that was made, or what was read. */
  url: string;
  hits: Hit[];
}

export interface Backend {
  readonly id: BackendId;
  search(query: string, limit: number, signal?: AbortSignal): Promise<Searched>;
}

export const MAX_TEXT_CHARS = 4000;
export const MAX_TITLE_CHARS = 300;

const isRecord = (v: unknown): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A link a site gave, kept only when it is an https address; otherwise the backend's own address stands. */
function linkOr(given: unknown, allowedHosts: readonly string[], fallback: string): string {
  const candidate = str(given);
  if (candidate === "") return fallback;
  try {
    const url = new URL(candidate);
    if (url.protocol === "https:" && url.username === "" && url.password === "") return url.href.slice(0, 500);
  } catch {
    // fall through
  }
  void allowedHosts;
  return fallback;
}

export interface RemoteSettings {
  baseUrl: string;
  allowedHosts: readonly string[];
  fetcher: Fetcher;
}

function done(hits: Hit[], limit: number): Hit[] {
  return hits.filter((h) => h.title !== "" || h.text !== "").slice(0, limit);
}

// --- OpenAlex ---------------------------------------------------------------------------------

/** OpenAlex stores an abstract as an inverted index (word to positions). */
export function abstractOf(index: unknown): string {
  if (!isRecord(index)) return "";
  const words: string[] = [];
  let total = 0;
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue;
    for (const p of positions) {
      if (typeof p === "number" && Number.isInteger(p) && p >= 0 && p < 20_000 && total++ < 20_000) words[p] = word;
    }
  }
  return words.filter((w) => w !== undefined).join(" ");
}

export function openalex(s: RemoteSettings): Backend {
  return {
    id: "openalex",
    async search(query, limit, signal) {
      const url = `${s.baseUrl}/works?search=${encodeURIComponent(query)}&per-page=${limit}&select=id,doi,title,abstract_inverted_index`;
      const json = await s.fetcher.json(url, signal);
      const list = isRecord(json) && Array.isArray(json.results) ? json.results : undefined;
      if (list === undefined) throw new LitError(`${url}: the answer has no list of results`);
      const hits = list.flatMap((raw): Hit[] => {
        if (!isRecord(raw)) return [];
        return [{ backend: "openalex", url: linkOr(raw.doi ?? raw.id, s.allowedHosts, s.baseUrl), title: clean(str(raw.title), MAX_TITLE_CHARS), text: clean(abstractOf(raw.abstract_inverted_index), MAX_TEXT_CHARS) }];
      });
      return { url, hits: done(hits, limit) };
    },
  };
}

// --- Semantic Scholar -------------------------------------------------------------------------

export function semanticScholar(s: RemoteSettings): Backend {
  return {
    id: "semantic-scholar",
    async search(query, limit, signal) {
      const url = `${s.baseUrl}/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=title,abstract,url`;
      const json = await s.fetcher.json(url, signal);
      const list = isRecord(json) && Array.isArray(json.data) ? json.data : undefined;
      if (list === undefined) throw new LitError(`${url}: the answer has no list in data`);
      const hits = list.flatMap((raw): Hit[] => (isRecord(raw) ? [{ backend: "semantic-scholar", url: linkOr(raw.url, s.allowedHosts, s.baseUrl), title: clean(str(raw.title), MAX_TITLE_CHARS), text: clean(str(raw.abstract), MAX_TEXT_CHARS) }] : []));
      return { url, hits: done(hits, limit) };
    },
  };
}

// --- zbMATH -----------------------------------------------------------------------------------

export function zbmath(s: RemoteSettings): Backend {
  return {
    id: "zbmath",
    async search(query, limit, signal) {
      const url = `${s.baseUrl}/v1/document/_search?search_string=${encodeURIComponent(query)}&page=0&results_per_page=${limit}`;
      const json = await s.fetcher.json(url, signal);
      const list = isRecord(json) ? (Array.isArray(json.result) ? json.result : Array.isArray(json.results) ? json.results : undefined) : undefined;
      if (list === undefined) throw new LitError(`${url}: the answer has no list of results`);
      const hits = list.flatMap((raw): Hit[] => {
        if (!isRecord(raw)) return [];
        const title = isRecord(raw.title) ? str(raw.title.title) : str(raw.title);
        const reviews = Array.isArray(raw.editorial_contributions) ? raw.editorial_contributions.flatMap((c) => (isRecord(c) ? [str(c.text)] : [])) : [];
        const links = Array.isArray(raw.links) ? raw.links.flatMap((l) => (isRecord(l) ? [str(l.url)] : [])) : [];
        const id = typeof raw.id === "number" || typeof raw.id === "string" ? String(raw.id) : "";
        const own = /^[\w.-]+$/.test(id) ? `${s.baseUrl.replace(/^(https?:\/\/)api\./, "$1")}/${id}` : s.baseUrl;
        return [{ backend: "zbmath", url: linkOr(links[0] ?? own, s.allowedHosts, s.baseUrl), title: clean(title, MAX_TITLE_CHARS), text: clean(reviews.join(" "), MAX_TEXT_CHARS) }];
      });
      return { url, hits: done(hits, limit) };
    },
  };
}

// --- arXiv ------------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function unescapeXml(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, name: string) => {
      if (name.startsWith("#")) {
        const code = name[1]?.toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
        return Number.isInteger(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
      }
      return ENTITIES[name.toLowerCase()] ?? m;
    });
}

const tagText = (entry: string, tag: string): string => unescapeXml(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(entry)?.[1] ?? "");

/** The entries of an Atom feed: id, title and summary, with the markup of the text left out. */
export function atomEntries(xml: string): Array<{ id: string; title: string; summary: string }> {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => ({ id: tagText(m[1] ?? "", "id"), title: tagText(m[1] ?? "", "title"), summary: tagText(m[1] ?? "", "summary") }));
}

export function arxiv(s: RemoteSettings): Backend {
  return {
    id: "arxiv",
    async search(query, limit, signal) {
      const url = `${s.baseUrl}/api/query?search_query=${encodeURIComponent(`all:${query}`)}&start=0&max_results=${limit}`;
      const xml = await s.fetcher.text(url, signal);
      if (!/<feed[\s>]/.test(xml)) throw new LitError(`${url}: the answer is not an Atom feed`);
      const hits = atomEntries(xml).map((e): Hit => ({ backend: "arxiv", url: linkOr(e.id.trim().replace(/^http:/, "https:"), s.allowedHosts, s.baseUrl), title: clean(e.title, MAX_TITLE_CHARS), text: clean(e.summary, MAX_TEXT_CHARS) }));
      return { url, hits: done(hits, limit) };
    },
  };
}

// --- The metadata of a local bench checkout ---------------------------------------------------

const FILE_LIMIT = 6000;
const FILE_BYTES = 400_000;

function* leanFiles(dir: string): Generator<string> {
  let seen = 0;
  const stack = [dir];
  while (stack.length > 0 && seen < FILE_LIMIT) {
    const here = stack.pop() as string;
    for (const entry of readdirSync(here, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const path = join(here, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && entry.name.endsWith(".lean") && seen++ < FILE_LIMIT) yield path;
    }
  }
}

const STOP = new Set(["the", "a", "an", "of", "and", "or", "for", "in", "on", "to", "is", "are", "that", "with", "all", "every", "there", "exists", "conjecture", "theorem", "proof", "counterexample"]);
export const wordsOf = (text: string): string[] => [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter((w) => !STOP.has(w));

/**
 * What a bench checkout records about a problem outside Lean's statement: the docstring above a declaration (it names the source,
 * often a paper) and the `formal_proof using KIND at "URL"` attribute. A declaration is a hit when its words cover enough of the
 * query's; the text is the docstring and the attribute, and the link is the formal proof's URL when it has one, and the file otherwise.
 */
export function benchMetadata(dir: string): Backend {
  return {
    id: "bench-metadata",
    async search(query, limit) {
      if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new LitError(`${dir} is not a directory`);
      const wanted = wordsOf(query).slice(0, 12);
      const scored: Array<{ score: number; hit: Hit }> = [];
      if (wanted.length > 0) {
        for (const file of leanFiles(dir)) {
          if (statSync(file).size > FILE_BYTES) continue;
          const source = readFileSync(file, "utf8");
          for (const m of source.matchAll(/\/--([\s\S]*?)-\/\s*((?:@\[[^\]]*\]\s*)*)(?:theorem|lemma)\s+([\w.'']+)/g)) {
            const doc = clean(m[1] ?? "", MAX_TEXT_CHARS);
            const attributes = m[2] ?? "";
            const proof = /\bformal_proof\s+using\s+(\w+)\s+at\s+"([^"]*)"/.exec(attributes);
            const text = clean(`${doc}${proof !== null ? ` formal_proof using ${proof[1]} at ${proof[2]}` : ""}`, MAX_TEXT_CHARS);
            const have = new Set(wordsOf(`${text} ${m[3] ?? ""}`));
            const score = wanted.filter((w) => have.has(w)).length / wanted.length;
            if (score < 0.5) continue;
            const line = source.slice(0, m.index).split("\n").length;
            const link = proof?.[2] !== undefined && proof[2].startsWith("https://") ? proof[2] : `file:${relative(dir, file)}#L${line}`;
            scored.push({ score, hit: { backend: "bench-metadata", url: link.slice(0, 500), title: clean(m[3] ?? "", MAX_TITLE_CHARS), text } });
          }
        }
      }
      scored.sort((a, b) => b.score - a.score);
      return { url: `file:${dir}`, hits: scored.slice(0, limit).map((s) => s.hit) };
    },
  };
}

/** The backend of an id, from its setting; `undefined` when the setting does not enable it (no address, no directory). */
export function makeBackend(id: BackendId, setting: { baseUrl?: string; allowedHosts?: readonly string[]; dir?: string }, fetcherOptions: Omit<FetcherOptions, "allowedHosts">): Backend | undefined {
  if (id === "bench-metadata") return setting.dir === undefined || setting.dir === "" ? undefined : benchMetadata(setting.dir);
  if (setting.baseUrl === undefined || setting.baseUrl === "") return undefined;
  const baseUrl = setting.baseUrl.replace(/\/+$/, "");
  const allowedHosts = setting.allowedHosts ?? [];
  const refused = refusalOf(`${baseUrl}/`, allowedHosts);
  if (refused !== undefined) throw new Error(`${id}: ${refused}`);
  const s: RemoteSettings = { baseUrl, allowedHosts, fetcher: new Fetcher({ ...fetcherOptions, allowedHosts }) };
  switch (id) {
    case "openalex":
      return openalex(s);
    case "arxiv":
      return arxiv(s);
    case "semantic-scholar":
      return semanticScholar(s);
    case "zbmath":
      return zbmath(s);
  }
}
