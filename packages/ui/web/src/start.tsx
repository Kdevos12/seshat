import { useEffect, useState } from "preact/hooks";
import { get, type Job, message, type ModelInfo, post, type Provider } from "./api.ts";
import { SettingsPanel } from "./parameters.tsx";
import { money, Notice, Section, when } from "./ui.tsx";

interface RunItem {
  id: string;
  modified: number;
  active: string | null;
  /** What the run is about, where it stands and what it cost (UX4); null when it could not be read or is not among the newest. */
  summary: { title: string; level: string | null; problems: number; state: "finished" | "paused" | "cut"; usd: number; model: string | null } | null;
}

const LEVEL_WORDS: Record<string, string> = { proved: "Proved", refuted: "Refuted", candidate: "Candidate", leads: "Leads only", working: "Working", ended: "Ended", nothing: "Nothing yet" };
const STATE_WORDS = { finished: "finished", paused: "paused, waits for you", cut: "stopped" } as const;

/** The start screen: a statement in prose or Lean, a spend ceiling, and the runs already there. */
export function Start() {
  const [statement, setStatement] = useState("");
  const [mode, setMode] = useState<"auto" | "lean" | "prose">("auto");
  const [maxUsd, setMaxUsd] = useState("2");
  const [turnUsd, setTurnUsd] = useState("");
  const [outside, setOutside] = useState<"model" | "lit" | "private">("model");
  const [defaults, setDefaults] = useState<"v2" | "v1">("v2");
  const [providers, setProviders] = useState<Provider[] | undefined>();
  const [provider, setProvider] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [settings, setSettings] = useState<{ values: Record<string, unknown> | undefined; error: string | undefined }>({ values: undefined, error: undefined });
  const [estimate, setEstimate] = useState<{ model?: string; rule?: string; line?: string } | undefined>();

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

  // What the ceiling buys with the model the run would use (UX10), asked once the typing stops.
  useEffect(() => {
    setEstimate(undefined);
    if (!Number.isFinite(ceiling) || ceiling <= 0 || (provider !== "" && model === "")) return;
    const timer = setTimeout(() => {
      get<{ model?: string; rule?: string; line?: string }>(`/api/estimate?maxUsd=${encodeURIComponent(String(ceiling))}${model !== "" ? `&model=${encodeURIComponent(model)}` : ""}`).then(setEstimate, () => setEstimate(undefined));
    }, 400);
    return () => clearTimeout(timer);
  }, [ceiling, provider, model]);
  const turn = turnUsd.trim() === "" ? undefined : Number(turnUsd);
  const turnOk = turn === undefined || (Number.isFinite(turn) && turn > 0 && turn <= ceiling);
  const ready = statement.trim() !== "" && Number.isFinite(ceiling) && ceiling > 0 && turnOk && !busy && settings.error === undefined;

  const start = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const body = {
        kind: "solve",
        statement,
        mode,
        maxUsd: ceiling,
        ...(turn !== undefined ? { turnUsd: turn } : {}),
        ...(outside !== "model" ? { outside } : {}),
        ...(defaults !== "v2" ? { defaults } : {}),
        ...(model !== "" ? { model } : {}),
        ...(settings.values !== undefined ? { settings: settings.values } : {}),
      };
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
              ["auto", "Detect automatically"],
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
            <p class="muted small">Everything counts against it, the formalization included. The run stops by itself at the ceiling, and earlier, for you to look (below).</p>
            {estimate?.line !== undefined ? (
              <p class="small estimate" id="estimate">
                {estimate.line}
                {provider === "" && estimate.model !== undefined ? ` The model chosen for you: ${estimate.model}.` : ""}
              </p>
            ) : null}
            <label for="turn">Stop for me to look after (US dollars, optional)</label>
            <input id="turn" type="number" inputMode="decimal" min="0.01" step="any" value={turnUsd} placeholder={Number.isFinite(ceiling) && ceiling > 0 ? `${Math.round(ceiling * 50) / 100} (half the ceiling)` : "half the ceiling"} onInput={(e) => setTurnUsd((e.target as HTMLInputElement).value)} />
            {!turnOk ? <p class="small error-text">At most the ceiling, and above zero.</p> : null}
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
        <fieldset class="choices">
          <legend>What may leave this machine</legend>
          <p class="muted small">The model's provider always receives the work. Nothing else does unless you say so here.</p>
          <div class="radio stacked" role="radiogroup" aria-label="Outside services">
            {(
              [
                ["model", "Only the model's provider (default)", "The literature search and remote Lean search stay off."],
                ["lit", "Also the literature and Lean search services", "The statement's words go to the paper search services and the Lean search service your host lists (the Checklist names them), to look for a result that already settles it. Your yes is journaled."],
                ["private", "Strictly private", "Nothing goes to any third party: no literature, local Lean search only, no outside data or decision services (--private)."],
              ] as const
            ).map(([value, label, help]) => (
              <label key={value}>
                <input type="radio" name="outside" checked={outside === value} onChange={() => setOutside(value)} /> {label}
                <span class="muted small block">{help}</span>
              </label>
            ))}
          </div>
          <label for="defaults">Defaults</label>
          <select id="defaults" value={defaults} onChange={(e) => setDefaults((e.target as HTMLSelectElement).value as "v2" | "v1")}>
            <option value="v2">v2 (recommended): the newer defaults of solve</option>
            <option value="v1">v1: solve as it was before the defaults sets</option>
          </select>
        </fieldset>
        <SettingsPanel command="solve" defaults={defaults} onChange={(values, problem) => setSettings({ values, error: problem })} />
        {settings.error !== undefined ? <Notice kind="error">{settings.error}</Notice> : null}
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
              <li key={r.id} class="runitem">
                <a href={`#/run/${encodeURIComponent(r.id)}`}>{r.summary !== null ? r.summary.title : r.id}</a>
                {r.summary !== null && r.summary.level !== null ? <span class={`chip level-${r.summary.level}`}>{LEVEL_WORDS[r.summary.level] ?? r.summary.level}</span> : null}
                {r.active !== null ? <span class="chip"> working</span> : null}
                <div class="muted small">
                  {r.summary !== null ? `${r.summary.problems > 1 ? `${r.summary.problems} problems, ` : ""}${money(r.summary.usd)} spent, ${STATE_WORDS[r.summary.state]}${r.summary.model !== null ? `, ${r.summary.model}` : ""} · ` : ""}
                  {when(r.modified)} · <code>{r.id}</code>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
