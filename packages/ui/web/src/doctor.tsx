import { useEffect, useState } from "preact/hooks";
import { type Check, get, message } from "./api.ts";
import { Notice } from "./ui.tsx";

const WORDS = { ok: "Ready", warn: "Warning", missing: "Missing" } as const;

/** What `harness doctor` finds on this machine, as a checklist. It checks and writes nothing. */
export function Doctor() {
  const [report, setReport] = useState<{ ok: boolean; checks: Check[]; model?: { name: string; price: number } } | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const run = () => {
    setBusy(true);
    setError(undefined);
    get<{ ok: boolean; checks: Check[]; model?: { name: string; price: number } }>("/api/doctor").then(
      (r) => {
        setReport(r);
        setBusy(false);
      },
      (e) => {
        setError(message(e));
        setBusy(false);
      },
    );
  };
  useEffect(run, []);
  return (
    <>
      <h1>What this machine needs</h1>
      <p class="muted">The same checks as <code>harness doctor</code>, in the order a person would fix them. Nothing is changed by looking.</p>
      {error !== undefined ? <Notice kind="error">{error}</Notice> : null}
      {report !== undefined ? (
        <Notice kind={report.ok ? "info" : "warn"}>{report.ok ? "Everything a run needs is here." : "Something a run needs is missing."}{report.model !== undefined ? ` A run would use ${report.model.name}.` : ""}</Notice>
      ) : null}
      <div class="card">
        {report === undefined && error === undefined ? <p class="muted">Checking...</p> : null}
        {report?.checks.map((c) => (
          <div class="check" key={c.id}>
            <span class={`mark ${c.status}`}>{WORDS[c.status]}</span>
            <div>
              <strong>{c.title}</strong>
              <div>{c.detail}</div>
              {c.fix !== undefined ? <div class="muted">What to do: {c.fix}</div> : null}
            </div>
          </div>
        ))}
        <div class="actions">
          <button type="button" class="ghost" onClick={run} disabled={busy}>
            {busy ? "Checking..." : "Check again"}
          </button>
        </div>
      </div>
    </>
  );
}
