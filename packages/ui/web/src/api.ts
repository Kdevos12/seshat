// The only place the page talks to the server. Every change carries the header the server requires; no key is ever read back.

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(method !== "GET" ? { "x-seshat-request": "1" } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = text === "" ? {} : JSON.parse(text);
  } catch {
    data = { error: text.slice(0, 200) };
  }
  if (!response.ok) throw new ApiError((data as { error?: string }).error ?? `The server answered ${response.status}.`, response.status);
  return data as T;
}

export const get = <T>(path: string): Promise<T> => call<T>("GET", path);
export const post = <T>(path: string, body: unknown = {}): Promise<T> => call<T>("POST", path, body);
export const put = <T>(path: string, body: unknown): Promise<T> => call<T>("PUT", path, body);
export const del = <T>(path: string): Promise<T> => call<T>("DELETE", path);

export const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Follows a server-sent event stream; returns the way to stop. */
export function follow(path: string, handlers: Record<string, (data: string) => void>, onError?: () => void): () => void {
  const source = new EventSource(path, { withCredentials: true });
  for (const [name, handler] of Object.entries(handlers)) source.addEventListener(name, (e) => handler((e as MessageEvent<string>).data));
  source.onerror = () => onError?.();
  return () => source.close();
}

// ---- The shapes the server sends. They are the reader's (packages/ui/src/reader.ts); only what the page uses is listed.

export interface Provider {
  id: string;
  name: string;
  models: number;
  variable: string | null;
  configured: boolean;
  source: string | null;
  stored: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  context: number;
  reasoning: boolean;
  inputPrice: number;
  outputPrice: number;
}

export interface Check {
  id: string;
  status: "ok" | "warn" | "missing";
  title: string;
  detail: string;
  fix?: string;
}

export interface Signature {
  source: "prose" | "lean";
  prose?: string;
  theorem: string;
  statement: string;
  statementId: string;
  testLemmas?: { result: string; tried: number; failedAt?: string; note?: string };
  trivial?: { by: string };
  notes: string[];
}

export interface OutputLine {
  n: number;
  stream: "out" | "err";
  text: string;
}

export interface Job {
  id: string;
  kind: string;
  command: string[];
  runId?: string;
  state: "running" | "awaiting_signature" | "exited" | "failed" | "stopped";
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  signature?: Signature;
  detached: boolean;
  logFile?: string;
  lines: OutputLine[];
}

export interface PlainStatus {
  target: string;
  claimId: string;
  claimStatus: string;
  level: "proved" | "refuted" | "candidate" | "leads" | "working" | "ended" | "nothing";
  text: string;
}

export interface ClaimView {
  id: string;
  status: string;
  statement: string;
  kind: string;
  parent: string | null;
  target: boolean;
}

export interface EdgeView {
  id: string;
  kind: string;
  from: string;
  to: string[];
  status: string;
}

export interface RecordLine {
  id: string;
  kind: string;
  claimId?: string;
  text: string;
}

export interface SiteLine {
  site: string;
  calls: number;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  share: number;
}

export interface ProofFile {
  claimId: string;
  statement: string;
  validationId: string;
  negation: boolean;
  axioms: string[];
  file?: string;
}

export interface Turn {
  turn: number;
  limit: Record<string, number>;
  source: string;
  end: { reason: string; detail: string; minutes: number; spentTurnUsd: number; spentRunUsd: number } | null;
  account: { summary: { asked: string[] }; team: { since: Array<{ kind: string; by: string; text: string }> } } | null;
}

export interface Run {
  id: string;
  runId: string;
  state: "finished" | "paused" | "cut";
  stop: { reason: string; detail: string } | null;
  journal: { events: number; head: string; chain: string };
  model: string | null;
  status: PlainStatus[];
  certifier: { name: string | null; unavailable?: string };
  signature: { statement: string; prose?: string; by: string } | null;
  claims: ClaimView[];
  claimsOmitted: number;
  claimCounts: Record<string, number>;
  edges: EdgeView[];
  leads: RecordLine[];
  evidence: RecordLine[];
  turns: Turn[];
  spend: { usd: number; inputTokens: number; outputTokens: number; budgetUsd?: number; sites: SiteLine[]; rungs?: Record<string, number>; leftUsd: number | null };
  proof: { certified: ProofFile[]; candidates: ProofFile[]; partial: Array<{ claimId: string; statement: string; holes: number; proof: string }> };
  failed: Array<{ claimId: string; strategy: string; attempts: number; lastFailure?: string }>;
  resume: string;
  resumeInfo: { checkout: string } | null;
  resultMd: string;
}
