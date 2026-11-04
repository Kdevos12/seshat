import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ApiError, follow, get, type Job, message, post, type ProofFile, type Run, type Signature } from "./api.ts";
import { Graph } from "./graph.tsx";
import { Chip, Code, CopyButton, money, Notice, Section } from "./ui.tsx";

const ACTIVE = new Set(["running", "awaiting_signature"]);

/** One run: what it is doing, what it costs, what it found, and what the person can do next. It only reads the journal and starts commands. */
export function RunView(props: { id: string; jobId?: string | undefined }) {
  const [run, setRun] = useState<Run | undefined>();
  const [missing, setMissing] = useState(false);
  const [job, setJob] = useState<Job | undefined>();
  const [error, setError] = useState<string | undefined>();
  const jobId = useRef(props.jobId);

  const loadRun = useCallback(async () => {
    try {
      const r = await get<{ run: Run; activeJob: Job | null }>(`/api/runs/${encodeURIComponent(props.id)}`);
      setRun(r.run);
      setMissing(false);
      if (r.activeJob !== null) {
        jobId.current = r.activeJob.id;
        setJob(r.activeJob);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setMissing(true);
      else setError(message(e));
    }
  }, [props.id]);

  const loadJob = useCallback(async () => {
    if (jobId.current === undefined) return;
    try {
      setJob((await get<{ job: Job }>(`/api/jobs/${encodeURIComponent(jobId.current)}`)).job);
    } catch (e) {
      setError(message(e));
    }
  }, []);

  // The first look, and a slow look again while a command works or the run has not started (the stream below makes it quick).
  useEffect(() => {
    void loadRun();
    void loadJob();
    const timer = setInterval(() => {
      void loadRun();
      void loadJob();
    }, 3000);
    return () => clearInterval(timer);
  }, [loadRun, loadJob]);

  // The journal grows: look again, at most a few times a second.
  const present = run !== undefined;
  useEffect(() => {
    if (!present) return;
    let wait: ReturnType<typeof setTimeout> | undefined;
    const stop = follow(`/api/runs/${encodeURIComponent(props.id)}/events`, {
      journal: () => {
        clearTimeout(wait);
        wait = setTimeout(() => void loadRun(), 300);
      },
    });
    return () => {
      clearTimeout(wait);
      stop();
    };
  }, [present, props.id, loadRun]);

  // The command's output.
  const watched = job?.id;
  useEffect(() => {
    if (watched === undefined || job === undefined || !ACTIVE.has(job.state)) return;
    let wait: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(wait);
      wait = setTimeout(() => {
        void loadJob();
        void loadRun();
      }, 150);
    };
    const stop = follow(`/api/jobs/${encodeURIComponent(watched)}/events`, { job: refresh, state: refresh });
    return () => {
      clearTimeout(wait);
      stop();
    };
  }, [watched, job?.state, loadJob, loadRun]);

  const active = job !== undefined && ACTIVE.has(job.state);

  return (
    <>
      <h1>{run?.signature?.statement !== undefined ? "Your problem" : "Run"} <code class="muted small">{props.id}</code></h1>
      {error !== undefined ? <Notice kind="error">{error}</Notice> : null}
      {job?.state === "awaiting_signature" && job.signature !== undefined ? <SignatureCard job={job} signature={job.signature} onAnswered={loadJob} /> : null}
      {job !== undefined ? <JobPanel job={job} onChange={() => { void loadJob(); void loadRun(); }} /> : null}
      {run === undefined ? (
        missing && job === undefined ? <Notice kind="warn">There is no run called <code>{props.id}</code> in the runs directory.</Notice> : missing ? <p class="muted">The run has not started yet.</p> : <p class="muted">Loading...</p>
      ) : (
        <>
          <StatusPanel run={run} />
          <SpendPanel run={run} job={active ? job : undefined} onStopped={loadJob} />
          <ResultPanel run={run} />
          <ContinuePanel run={run} active={active} onStarted={(j) => { jobId.current = j.id; setJob(j); }} />
          <TeamPanel run={run} />
          <Section title="Research graph" note="Read-only. The journal is the only source: each box is coloured by the status it holds.">
            <Graph claims={run.claims} edges={run.edges} />
            {run.claimsOmitted > 0 ? <p class="muted small">{run.claimsOmitted} more claim(s) are in the journal and not drawn.</p> : null}
          </Section>
          <EvidencePanel run={run} />
        </>
      )}
    </>
  );
}

function SignatureCard(props: { job: Job; signature: Signature; onAnswered: () => void }) {
  const s = props.signature;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const answer = async (yes: boolean) => {
    setBusy(true);
    try {
      await post(`/api/jobs/${encodeURIComponent(props.job.id)}/answer`, { yes });
      props.onAnswered();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };
  const t = s.testLemmas;
  return (
    <section class="card" aria-labelledby="sign-title">
      <h2 id="sign-title">Does this say what you mean?</h2>
      <p class="muted">Nothing has been spent. Signing records that you accept this statement as your meaning; it does not make it true, and the proof is still decided by Lean.</p>
      <div class="pair">
        {s.source === "prose" ? (
          <div>
            <h3>Your words</h3>
            <p>{s.prose}</p>
          </div>
        ) : null}
        <div>
          <h3>{s.source === "prose" ? "What a model made of them, in Lean" : "Your statement, in Lean"}</h3>
          <Code text={s.theorem} label="The Lean statement" />
        </div>
      </div>
      {t !== undefined ? (
        <Notice kind={t.result === "refuted" || t.failedAt !== undefined ? "warn" : "info"}>
          Tried on its first cases: {t.result}
          {t.tried > 0 ? ` (${t.tried} tried)` : ""}
          {t.failedAt !== undefined ? `; it fails at ${t.failedAt}, so it probably does not mean what you meant` : ""}
          {t.note !== undefined ? `. ${t.note}` : ""}
        </Notice>
      ) : null}
      {s.trivial !== undefined ? <Notice kind="warn">Cheap automation proves this as written ({s.trivial.by}): it is probably trivial, which may not be what you meant.</Notice> : null}
      {s.notes.map((n, i) => (
        <p class="muted small" key={i}>
          Note: {n}
        </p>
      ))}
      {error !== undefined ? <Notice kind="error">{error}</Notice> : null}
      <div class="actions">
        <button type="button" disabled={busy} onClick={() => answer(true)}>
          Yes, sign it and start
        </button>
        <button type="button" class="ghost" disabled={busy} onClick={() => answer(false)}>
          No, do not start
        </button>
      </div>
    </section>
  );
}

const STATE_WORDS: Record<Job["state"], string> = {
  running: "Working",
  awaiting_signature: "Waiting for your signature",
  exited: "Finished",
  failed: "Could not start",
  stopped: "Stopped by you",
};

function JobPanel(props: { job: Job; onChange: () => void }) {
  const { job } = props;
  const [error, setError] = useState<string | undefined>();
  const stop = async () => {
    try {
      await post(`/api/jobs/${encodeURIComponent(job.id)}/stop`);
      props.onChange();
    } catch (e) {
      setError(message(e));
    }
  };
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (box.current !== null) box.current.scrollTop = box.current.scrollHeight;
  }, [job.lines.length]);
  const active = ACTIVE.has(job.state);
  return (
    <Section title={`Command: ${job.kind}`}>
      <p>
        <strong>{STATE_WORDS[job.state]}</strong>
        {job.state === "exited" || job.state === "stopped" ? ` (exit code ${job.exitCode ?? "none"})` : ""}
        {job.detached ? ". It was started detached and goes on if you close this page; its output is in a file." : ""}
      </p>
      {error !== undefined ? <Notice kind="error">{error}</Notice> : null}
      {active ? (
        <div class="actions">
          <button type="button" class="danger" onClick={stop}>
            Stop
          </button>
        </div>
      ) : null}
      {job.lines.length > 0 ? (
        <details open={active}>
          <summary>What the command says</summary>
          <div class="console" ref={box} role="log">
            {job.lines.map((l) => (
              <div key={l.n} class={l.stream}>
                {l.text}
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </Section>
  );
}

const LEVEL_LABEL = { proved: "Proved", refuted: "Refuted", candidate: "Candidate", leads: "Leads only", working: "Working", ended: "Ended", nothing: "Nothing yet" } as const;

function StatusPanel(props: { run: Run }) {
  const { run } = props;
  return (
    <Section title="Where it stands">
      <div class="status">
        {run.status.map((s) => (
          <div class={`line ${s.level}`} key={s.claimId}>
            <span class="label">{LEVEL_LABEL[s.level]}</span>
            <code>{s.target}</code>
            <div>{s.text}</div>
          </div>
        ))}
      </div>
      <p class="muted small">
        {run.state === "finished" ? "The run is over" : run.state === "paused" ? "The run is paused, waiting for you" : "The journal has no end: the run is working, or was cut"}
        {run.stop !== null ? `: ${run.stop.detail}` : ""}. {run.journal.events} events. Only a Lean kernel check makes a statement proved or refuted; a candidate or a program's finding is not that.
      </p>
      {run.journal.chain !== "verified" ? <Notice kind="error">The journal's hash chain does not verify ({run.journal.chain}). Do not trust anything on this page until the journal is restored.</Notice> : null}
      {run.certifier.name === null || run.certifier.unavailable !== undefined ? (
        <Notice kind="warn">No certifier ran{run.certifier.unavailable !== undefined ? ` (${run.certifier.unavailable.slice(0, 200)})` : ""}: a proof that passes the fast check stays a candidate.</Notice>
      ) : null}
    </Section>
  );
}

function SpendPanel(props: { run: Run; job: Job | undefined; onStopped: () => void }) {
  const { spend } = props.run;
  const budget = spend.budgetUsd;
  const share = budget !== undefined && budget > 0 ? Math.min(1, spend.usd / budget) : 0;
  const max = Math.max(1e-9, ...spend.sites.map((s) => s.usd));
  const stop = async () => {
    if (props.job === undefined) return;
    try {
      await post(`/api/jobs/${encodeURIComponent(props.job.id)}/stop`);
    } finally {
      props.onStopped();
    }
  };
  return (
    <Section title="What it has cost">
      <p>
        <strong>{money(spend.usd)}</strong>
        {budget !== undefined ? ` of ${money(budget)}` : ""}
        {spend.leftUsd !== null ? `, ${money(spend.leftUsd)} left` : ""}. {spend.inputTokens.toLocaleString()} input and {spend.outputTokens.toLocaleString()} output tokens.
      </p>
      {budget !== undefined ? (
        <div class={`gauge${share > 0.8 ? " hot" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={budget} aria-valuenow={spend.usd} aria-label="Spend against the ceiling">
          <div class={`w-${Math.round(share * 20) * 5}`} />
        </div>
      ) : null}
      {props.job !== undefined ? (
        <div class="actions">
          <button type="button" class="danger" onClick={stop}>
            Stop now
          </button>
          <span class="muted small">Like Ctrl-C: the work in progress ends and RESULT.md is written. What you have not spent stays yours.</span>
        </div>
      ) : null}
      {spend.sites.length > 0 ? (
        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th>Where it was spent</th>
                <th class="num">Calls</th>
                <th class="num">Dollars</th>
                <th class="num">Share</th>
              </tr>
            </thead>
            <tbody>
              {spend.sites.map((s) => (
                <tr key={s.site}>
                  <td>
                    <code>{s.site}</code>
                    <div class="minibar">
                      <div class={`w-${Math.round((s.usd / max) * 20) * 5}`} />
                    </div>
                  </td>
                  <td class="num">{s.calls}</td>
                  <td class="num">{money(s.usd)}</td>
                  <td class="num">{Math.round(s.share * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p class="muted">Nothing has been spent on a model yet.</p>
      )}
      {spend.rungs !== undefined ? (
        <p class="small muted">
          By rung of the ladder: {Object.entries(spend.rungs).sort(([a], [b]) => Number(a) - Number(b)).map(([r, usd]) => `rung ${r} ${money(usd)}`).join(", ")}.
        </p>
      ) : null}
    </Section>
  );
}

function Proof(props: { p: ProofFile }) {
  const { p } = props;
  return (
    <article class="card">
      <h3>
        {p.negation ? "Refutation" : "Proof"} of <code>{p.claimId}</code> <span class={`chip ${p.negation ? "s-refuted" : "s-proved"}`}>certified by the Lean kernel</span>
      </h3>
      <p class="small">
        Statement: <code>{p.statement}</code>
      </p>
      <p class="small muted">
        Kernel replay {p.validationId}; axioms: {p.axioms.length === 0 ? "none" : p.axioms.join(", ")}.
      </p>
      {p.file !== undefined ? (
        <>
          <Code text={p.file} label="The certified Lean file" />
          <CopyButton text={p.file} label="Copy the proof" />
        </>
      ) : (
        <p class="muted">The Lean file's blob is not in the run directory.</p>
      )}
    </article>
  );
}

function ResultPanel(props: { run: Run }) {
  const { proof } = props.run;
  return (
    <Section title="The result">
      {proof.certified.length === 0 ? <p>No Lean proof is certified yet. A statement is proved or refuted only when the kernel replay certified a proof.</p> : proof.certified.map((p) => <Proof key={p.validationId} p={p} />)}
      {proof.candidates.length > 0 ? (
        <details>
          <summary>{proof.candidates.length} candidate(s) that passed the fast check and are not certified</summary>
          <Notice kind="warn">These are not results. Until the kernel replay certifies them they may be wrong.</Notice>
          {proof.candidates.map((p) => (
            <div key={p.validationId}>
              <p>
                <code>{p.claimId}</code> <Chip status="computed" />
              </p>
              {p.file !== undefined ? <Code text={p.file} /> : null}
            </div>
          ))}
        </details>
      ) : null}
      {proof.partial.length > 0 ? (
        <details>
          <summary>{proof.partial.length} partial sketch(es) with open holes</summary>
          <Notice kind="warn">Not proofs: each still has <code>sorry</code>.</Notice>
          {proof.partial.map((s) => (
            <div key={s.claimId}>
              <p>
                <code>{s.claimId}</code>: {s.holes} open hole(s)
              </p>
              <Code text={s.proof} />
            </div>
          ))}
        </details>
      ) : null}
      <details>
        <summary>RESULT.md</summary>
        <CopyButton text={props.run.resultMd} label="Copy RESULT.md" />
        <Code text={props.run.resultMd} label="RESULT.md" />
      </details>
    </Section>
  );
}

function useName(): [string, (v: string) => void] {
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem("seshat-name") ?? "";
    } catch {
      return "";
    }
  });
  return [
    name,
    (v) => {
      setName(v);
      try {
        localStorage.setItem("seshat-name", v);
      } catch {
        // A browser that keeps nothing keeps nothing.
      }
    },
  ];
}

function ContinuePanel(props: { run: Run; active: boolean; onStarted: (job: Job) => void }) {
  const { run } = props;
  const [name, setName] = useName();
  const [turnUsd, setTurnUsd] = useState("");
  const [detached, setDetached] = useState(false);
  const [claim, setClaim] = useState("");
  const [text, setText] = useState("");
  const [focus, setFocus] = useState("");
  const [drop, setDrop] = useState("");
  const [forbid, setForbid] = useState("");
  const [edge, setEdge] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [said, setSaid] = useState<string | undefined>();

  const send = async (body: Record<string, unknown>, ok: string) => {
    setError(undefined);
    setSaid(undefined);
    try {
      const { job } = await post<{ job: Job }>("/api/jobs", { runId: run.id, ...(name.trim() !== "" ? { as: name.trim() } : {}), ...body });
      setSaid(ok);
      props.onStarted(job);
    } catch (e) {
      setError(message(e));
    }
  };

  if (props.active) return <Section title="Go on"><p class="muted">A command is working on this run. When it stops you can resume it, add a hint, steer it or sign an edge.</p></Section>;
  const finished = run.state === "finished";
  const unsigned = run.edges.filter((e) => e.status !== "lean_checked" && e.status !== "human_signed");
  const claims = [...run.claims].sort((a, b) => Number(b.target) - Number(a.target));
  const limit = turnUsd.trim() === "" ? {} : { turnUsd: Number(turnUsd) };
  return (
    <Section title="Go on" note={finished ? "This run is finished. Start a new one to try again; --memory-from carries what it learned." : undefined}>
      {error !== undefined ? <Notice kind="error">{error}</Notice> : null}
      {said !== undefined ? <Notice>{said}</Notice> : null}
      {!finished ? (
        <>
          <h3>Continue</h3>
          <p class="muted small">
            {run.spend.leftUsd !== null ? `${money(run.spend.leftUsd)} of the allowance is left. ` : ""}A bigger limit lets the next stretch of work spend more of it before it stops for you to look; the allowance fixed at the start is not raised.
          </p>
          <div class="row">
            <div>
              <label for="turn-usd">Spend at most this much before stopping again (US dollars, optional)</label>
              <input id="turn-usd" type="number" inputMode="decimal" min="0" step="any" value={turnUsd} onInput={(e) => setTurnUsd((e.target as HTMLInputElement).value)} />
            </div>
          </div>
          <div class="radio">
            <label>
              <input type="checkbox" checked={detached} onChange={(e) => setDetached((e.target as HTMLInputElement).checked)} /> Keep going if I close this page
            </label>
          </div>
          <div class="actions">
            <button type="button" disabled={run.resumeInfo === null} onClick={() => send({ kind: "resume", detached, ...limit }, "Resuming.")}>
              Continue the run
            </button>
          </div>
          {run.resumeInfo === null ? <p class="muted small">This run has no resume.json, so it can be resumed only with the command in RESULT.md.</p> : null}
        </>
      ) : null}
      <h3>Your name on what you add</h3>
      <input type="text" value={name} placeholder="optional; default is your login name" onInput={(e) => setName((e.target as HTMLInputElement).value)} aria-label="Your name" />
      <h3>Give a hint</h3>
      <p class="muted small">A hint is shown to the next sessions on that claim as a hint, never as a fact. It changes no status.</p>
      <label for="hint-claim">Claim</label>
      <select id="hint-claim" value={claim} onChange={(e) => setClaim((e.target as HTMLSelectElement).value)}>
        <option value="">Choose a claim</option>
        {claims.map((c) => (
          <option key={c.id} value={c.id}>
            {c.id} ({c.status}): {c.statement.slice(0, 60)}
          </option>
        ))}
      </select>
      <label for="hint-text">Hint</label>
      <textarea id="hint-text" value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
      <div class="actions">
        <button type="button" disabled={claim === "" || text.trim() === ""} onClick={() => send({ kind: "hint", claimId: claim, text }, "Hint recorded.")}>
          Add the hint
        </button>
      </div>
      {!finished ? (
        <>
          <h3>Steer</h3>
          <div class="row">
            <div>
              <label for="steer-focus">Work first on</label>
              <select id="steer-focus" value={focus} onChange={(e) => setFocus((e.target as HTMLSelectElement).value)}>
                <option value="">No change</option>
                {claims.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label for="steer-drop">Give up on</label>
              <select id="steer-drop" value={drop} onChange={(e) => setDrop((e.target as HTMLSelectElement).value)}>
                <option value="">No change</option>
                {claims.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <label for="steer-forbid">Forbid a strategy (its name)</label>
          <input id="steer-forbid" type="text" value={forbid} onInput={(e) => setForbid((e.target as HTMLInputElement).value)} />
          <div class="actions">
            <button type="button" disabled={focus === "" && drop === "" && forbid.trim() === "" && turnUsd.trim() === ""} onClick={() => send({ kind: "steer", ...(focus !== "" ? { focus } : {}), ...(drop !== "" ? { drop } : {}), ...(forbid.trim() !== "" ? { forbid: forbid.trim() } : {}), ...limit }, "Steer recorded.")}>
              Record the steer
            </button>
          </div>
        </>
      ) : null}
      {unsigned.length > 0 ? (
        <>
          <h3>Sign an edge</h3>
          <p class="muted small">A signature says you accept a link. It is not a Lean check: it propagates nothing and changes no status.</p>
          <label for="sign-edge">Edge</label>
          <select id="sign-edge" value={edge} onChange={(e) => setEdge((e.target as HTMLSelectElement).value)}>
            <option value="">Choose an edge</option>
            {unsigned.map((e) => (
              <option key={e.id} value={e.id}>
                {e.kind}: {e.from} to {e.to.join(", ")} ({e.status})
              </option>
            ))}
          </select>
          <label for="sign-note">Note (optional)</label>
          <input id="sign-note" type="text" value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
          <div class="actions">
            <button type="button" disabled={edge === ""} onClick={() => send({ kind: "sign", edgeId: edge, ...(note.trim() !== "" ? { note: note.trim() } : {}) }, "Signature recorded.")}>
              Sign the edge
            </button>
          </div>
        </>
      ) : null}
    </Section>
  );
}

function TeamPanel(props: { run: Run }) {
  const turns = props.run.turns;
  if (turns.length === 0) return null;
  return (
    <Section title="Turns and questions" note="A turn is a stretch of work that stops for you to look. This is what each one says.">
      {turns.map((t) => (
        <div key={t.turn}>
          <h3>Turn {t.turn}</h3>
          <p class="small">
            {t.end === null ? "No end in the journal." : `Ended at ${t.end.reason}: ${t.end.detail}. Spent ${money(t.end.spentTurnUsd)} in the turn, ${money(t.end.spentRunUsd)} in the run.`}
          </p>
          {t.account !== null && t.account.summary.asked.length > 0 ? (
            <>
              <p>
                <strong>The team is asked:</strong>
              </p>
              <ul>
                {t.account.summary.asked.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </>
          ) : null}
          {t.account !== null && t.account.team.since.length > 0 ? (
            <ul>
              {t.account.team.since.map((a, i) => (
                <li key={i}>
                  {a.by} ({a.kind}): {a.text}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
    </Section>
  );
}

function EvidencePanel(props: { run: Run }) {
  const { run } = props;
  if (run.leads.length === 0 && run.evidence.length === 0 && run.failed.length === 0) return null;
  return (
    <Section title="Leads, evidence and what failed" note="Not proofs. Programs and small models find leads; none of it changes a statement's status.">
      {run.leads.length > 0 ? (
        <>
          <h3>Counter-example leads</h3>
          <ul class="plain">
            {run.leads.map((l) => (
              <li key={l.id}>
                <span class="chip">lead</span> <code>{l.id}</code> {l.kind}: {l.text}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {run.evidence.length > 0 ? (
        <>
          <h3>Indicative evidence</h3>
          <ul class="plain">
            {run.evidence.map((l) => (
              <li key={l.id}>
                <span class="chip">evidence</span> <code>{l.id}</code> {l.kind}: {l.text}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {run.failed.length > 0 ? (
        <>
          <h3>What was tried and failed</h3>
          <ul class="plain">
            {run.failed.map((f) => (
              <li key={`${f.claimId}-${f.strategy}`}>
                <code>{f.claimId}</code> by {f.strategy}: {f.attempts} attempt(s){f.lastFailure !== undefined ? `. ${f.lastFailure}` : ""}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Section>
  );
}
