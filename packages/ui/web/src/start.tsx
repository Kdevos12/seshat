import { useEffect, useState } from "preact/hooks";
import { get, type Job, message, type ModelInfo, post, type Provider } from "./api.ts";
import { Notice, Section } from "./ui.tsx";

interface RunItem {
  id: string;
  modified: number;
  active: string | null;
}

/** The start screen: a statement in prose or Lean, a spend ceiling, and the runs already there. */
export function Start() {
  const [statement, setStatement] = useState("");
  const [mode, setMode] = useState<"auto" | "lean" | "prose">("auto");
  const [maxUsd, setMaxUsd] = useState("2");
  const [providers, setProviders] = useState<Provider[] | undefined>();
  const [provider, setProvider] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<RunItem[]>([]);

  useEffect(() => {
    get<{ providers: Provider[] }>("/api/providers").then((r) => setProviders(r.providers), (e) => setError(message(e)));
    get<{ runs: RunItem[] }>("/api/runs").then((r) => setRuns(r.runs), () => {});
  }, []);

  useEffect(() => {
    setModel("");
    setModels([]);
    if (provider === "") return;
    get<{ models: ModelInfo[] }>(`/api/providers/${encodeURIComponent(provider)}/models`).then((r) => setModels(r.models), (e) => setError(message(e)));
  }, [provider]);

  const usable = (providers ?? []).filter((p) => p.configured);
  const ceiling = Number(maxUsd);
  const ready = statement.trim() !== "" && Number.isFinite(ceiling) && ceiling > 0 && !busy;

  const start = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const body = { kind: "solve", statement, mode, maxUsd: ceiling, ...(model !== "" ? { model } : {}) };
      const { job } = await post<{ job: Job }>("/api/jobs", body);
      location.hash = `#/run/${encodeURIComponent(job.runId ?? "")}/job/${encodeURIComponent(job.id)}`;
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };

  return (
    <>
      <h1>Give Seshat a problem</h1>
      <p class="muted">
        Write it in plain words or in Lean. A statement in words is turned into Lean and shown to you to sign before anything is spent. The run never spends more than the ceiling you set.
      </p>
      {providers !== undefined && usable.length === 0 ? (
        <Notice kind="warn">
          No model provider has credentials yet. <a href="#/settings">Add a key on the Providers page</a>, or export one in the shell that started this page.
        </Notice>
      ) : null}
      <form class="card" onSubmit={start}>
        <label for="statement">The statement</label>
        <textarea id="statement" value={statement} onInput={(e) => setStatement((e.target as HTMLTextAreaElement).value)} placeholder="Every even number above two is the sum of two primes.   or   (n : ℕ) : n + 0 = n" spellcheck={false} />
        <div class="radio" role="radiogroup" aria-label="How to read it">
          {(
            [
              ["auto", "Work it out"],
              ["prose", "It is in words"],
              ["lean", "It is Lean"],
            ] as const
          ).map(([value, label]) => (
            <label key={value}>
              <input type="radio" name="mode" checked={mode === value} onChange={() => setMode(value)} /> {label}
            </label>
          ))}
        </div>
        <div class="row">
          <div>
            <label for="ceiling">Spend ceiling (US dollars)</label>
            <input id="ceiling" type="number" inputMode="decimal" min="0.01" step="any" value={maxUsd} onInput={(e) => setMaxUsd((e.target as HTMLInputElement).value)} />
            <p class="muted small">Everything counts against it, the formalization included. The run stops by itself at the ceiling, and earlier, for you to look, once it has spent half.</p>
          </div>
          <div>
            <label for="provider">Model provider</label>
            <select id="provider" value={provider} onChange={(e) => setProvider((e.target as HTMLSelectElement).value)}>
              <option value="">Cheapest priced model (automatic)</option>
              {usable.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {provider !== "" ? (
              <>
                <label for="model">Model</label>
                <select id="model" value={model} onChange={(e) => setModel((e.target as HTMLSelectElement).value)}>
                  <option value="">Choose one</option>
                  {models.map((m) => (
                    <option key={m.name} value={m.name}>
                      {m.id} (${m.inputPrice}/${m.outputPrice} per million tokens)
                    </option>
                  ))}
                </select>
              </>
            ) : null}
          </div>
        </div>
        {error !== undefined ? <Notice kind="error">{error}</Notice> : null}
        <div class="actions">
          <button type="submit" disabled={!ready || (provider !== "" && model === "")}>
            {busy ? "Starting..." : "Prepare the statement"}
          </button>
        </div>
      </form>
      <Section title="Runs on this machine" note="From the runs directory the server was started with.">
        {runs.length === 0 ? (
          <p class="muted">No run yet.</p>
        ) : (
          <ul class="plain">
            {runs.map((r) => (
              <li key={r.id}>
                <a href={`#/run/${encodeURIComponent(r.id)}`}>{r.id}</a> <span class="muted small">{new Date(r.modified).toLocaleString()}</span>
                {r.active !== null ? <span class="chip"> working</span> : null}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
