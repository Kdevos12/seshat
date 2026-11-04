import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BlobStore, chainOfJournal, type HarnessEvent, type MemoryChain, Projection, readEvents } from "@seshat/core";
import { type Account, buildAccount } from "./account.ts";
import { blobReader, buildResult, money, type Result, resumeCommand, stopWords } from "./result.ts";
import { turnRecords } from "./turns.ts";

/**
 * `harness view RUN_DIR` (plan change PB7, documentation/quickstart.md, "The view"): one static HTML file built from the journal
 * alone. No server, no script, no network (a content security policy forbids all three), no model call. It reads the run and changes
 * nothing of it: the hints, signatures and steers stay commands. Every piece of text that came from the journal, a model or a person
 * is escaped; the page states a claim's status only as the projection of the journal holds it, and marks everything that is not a
 * certified Lean result (a candidate, a partial sketch, a counter-example, a tool's evidence) as what it is.
 */

/** Escapes text for an HTML body or a double-quoted attribute. */
export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const MAX_NODES = 80;
const NODE_W = 210;
const NODE_H = 54;
const GAP_X = 24;
const GAP_Y = 46;

/** The statuses a claim can have, with a short word for the legend. */
const STATUS_WORDS: Record<string, string> = {
  proved: "proved (Lean-certified)",
  refuted: "refuted (Lean-certified)",
  computed: "computed (passed the fast check, not certified)",
  proved_informal: "proved informally",
  open: "open",
  retracted: "retracted",
};

/** A status as a CSS class: the journal's own words only, anything else is `unknown`. */
function statusClass(status: string): string {
  return Object.hasOwn(STATUS_WORDS, status) ? `s-${status}` : "s-unknown";
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

interface Placed {
  id: string;
  status: string;
  statement: string;
  x: number;
  y: number;
  layer: number;
}

/** Lays the claims out in layers: a claim is one layer below the claim it was derived from or decomposed from. */
function layout(p: Projection, focus: readonly string[]): { nodes: Placed[]; width: number; height: number; omitted: number } {
  const claims = p.claimsWhere();
  const byId = new Map(claims.map((c) => [c.claim_id, c]));
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  const link = (from: string, to: string) => {
    if (!byId.has(from) || !byId.has(to) || from === to) return;
    children.set(from, [...(children.get(from) ?? []), to]);
    hasParent.add(to);
  };
  for (const c of claims) if (c.parent_id !== null) link(c.parent_id, c.claim_id);
  for (const e of p.edges({ kinds: ["decomposes_into"] })) for (const to of e.to) link(e.from_id, to);
  const roots = [...focus.filter((id) => byId.has(id)), ...claims.map((c) => c.claim_id).filter((id) => !hasParent.has(id) && !focus.includes(id))];
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const r of roots) {
    if (!depth.has(r)) {
      depth.set(r, 0);
      queue.push(r);
    }
  }
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i] as string;
    for (const child of children.get(id) ?? []) {
      if (depth.has(child)) continue;
      depth.set(child, (depth.get(id) ?? 0) + 1);
      queue.push(child);
    }
  }
  // Cycles and anything not reached are drawn in the first layer.
  for (const c of claims) if (!depth.has(c.claim_id)) depth.set(c.claim_id, 0);
  // At most MAX_NODES: the problems' claims and what is settled first, then the order of the journal.
  const rank = (id: string): number => (focus.includes(id) ? 0 : byId.get(id)?.status === "open" ? 2 : 1);
  const kept = [...claims].sort((a, b) => rank(a.claim_id) - rank(b.claim_id) || a.created_seq - b.created_seq).slice(0, MAX_NODES);
  const keptIds = new Set(kept.map((c) => c.claim_id));
  const layers = new Map<number, string[]>();
  for (const c of claims) {
    if (!keptIds.has(c.claim_id)) continue;
    const layer = depth.get(c.claim_id) ?? 0;
    layers.set(layer, [...(layers.get(layer) ?? []), c.claim_id]);
  }
  const widest = Math.max(1, ...[...layers.values()].map((l) => l.length));
  const width = widest * (NODE_W + GAP_X) + GAP_X;
  const nodes: Placed[] = [];
  const top = Math.max(-1, ...layers.keys());
  for (const [layer, ids] of [...layers].sort(([a], [b]) => a - b)) {
    const offset = (width - ids.length * (NODE_W + GAP_X) + GAP_X) / 2;
    ids.forEach((id, i) => {
      const c = byId.get(id);
      nodes.push({ id, status: c?.status ?? "unknown", statement: c?.statement ?? "", x: offset + i * (NODE_W + GAP_X), y: GAP_Y / 2 + layer * (NODE_H + GAP_Y), layer });
    });
  }
  return { nodes, width, height: (top + 1) * (NODE_H + GAP_Y) + GAP_Y / 2, omitted: Math.max(0, claims.length - kept.length) };
}

/** The research graph as inline SVG, with a text alternative in the tables below it. */
function graph(p: Projection, focus: readonly string[]): string {
  const { nodes, width, height, omitted } = layout(p, focus);
  if (nodes.length === 0) return `<p class="muted">The journal holds no claim yet.</p>`;
  const at = new Map(nodes.map((n) => [n.id, n]));
  const lines: string[] = [];
  const drawn = new Set<string>();
  const edge = (from: string, to: string, className: string, title: string) => {
    const a = at.get(from);
    const b = at.get(to);
    if (a === undefined || b === undefined) return;
    const key = `${from}>${to}>${className}`;
    if (drawn.has(key)) return;
    drawn.add(key);
    const x1 = a.x + NODE_W / 2;
    const y1 = a.y + NODE_H;
    const x2 = b.x + NODE_W / 2;
    const y2 = b.y;
    // A link within one layer, or upwards, bends to the side so it can be seen.
    const sideways = b.layer <= a.layer;
    const path = sideways ? `M ${x1} ${a.y + NODE_H / 2} C ${x1 + NODE_W} ${a.y - 20}, ${x2 + NODE_W} ${b.y - 20}, ${x2 + NODE_W / 2} ${b.y + NODE_H / 2}` : `M ${x1} ${y1} L ${x2} ${y2}`;
    lines.push(`<path class="edge ${className}" d="${path}"><title>${esc(title)}</title></path>`);
  };
  for (const c of p.claimsWhere()) if (c.parent_id !== null) edge(c.parent_id, c.claim_id, "e-part", "derived from");
  for (const e of p.edges()) {
    const className = e.status === "lean_checked" ? "e-checked" : e.status === "human_signed" ? "e-signed" : "e-proposed";
    for (const to of e.to) if (e.kind !== "uses" && e.kind !== "cites") edge(e.from_id, to, className, `${e.kind} (${e.status})`);
  }
  const boxes = nodes.map((n) => {
    const words = clip(n.statement, 64);
    const second = words.length > 32 ? [words.slice(0, 32), words.slice(32)] : [words, ""];
    return (
      `<g class="node ${statusClass(n.status)}" transform="translate(${n.x} ${n.y})">` +
      `<title>${esc(n.id)}: ${esc(n.status)}. ${esc(clip(n.statement, 300))}</title>` +
      `<rect width="${NODE_W}" height="${NODE_H}" rx="6"/>` +
      `<text x="8" y="16" class="node-id">${esc(n.id.slice(0, 22))}</text>` +
      `<text x="${NODE_W - 8}" y="16" text-anchor="end" class="node-status">${esc(n.status)}</text>` +
      `<text x="8" y="32" class="node-text">${esc(second[0] as string)}</text>` +
      `<text x="8" y="46" class="node-text">${esc(second[1] as string)}</text>` +
      `</g>`
    );
  });
  const legend = Object.entries(STATUS_WORDS)
    .map(([status, words]) => `<span class="key"><i class="swatch ${statusClass(status)}"></i>${esc(words)}</span>`)
    .join("");
  return (
    `<div class="legend">${legend}</div>` +
    `<div class="graph"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="The research graph: one box per claim, coloured by its status in the journal" width="${width}" height="${height}">` +
    `${lines.join("")}${boxes.join("")}</svg></div>` +
    `<p class="muted">Solid lines: derived from or decomposed into. Edges from a Lean-checked link are drawn solid green, a person's signature in blue, anything proposed dashed.${omitted > 0 ? ` ${omitted} more claim(s) are in the journal and not drawn.` : ""}</p>`
  );
}

function table(head: string[], rows: string[][]): string {
  if (rows.length === 0) return "";
  return `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

const code = (text: string) => `<code>${esc(text)}</code>`;
const pre = (text: string) => `<pre>${esc(text)}</pre>`;

function claimsTable(p: Projection): string {
  const rows = p.claimsWhere().slice(0, 200).map((c) => [code(c.claim_id), `<span class="pill ${statusClass(c.status)}">${esc(c.status)}</span>`, esc(clip(c.statement, 240))]);
  return table(["Claim", "Status", "Statement"], rows);
}

function edgesTable(p: Projection): string {
  const rows = p.edges().slice(0, 200).map((e) => [code(e.edge_id), esc(e.kind), code(e.from_id), e.to.map(code).join(", "), esc(e.status)]);
  return table(["Edge", "Kind", "From", "To", "Status"], rows);
}

function turnSection(events: readonly HarnessEvent[], blobs: BlobStore, chain: MemoryChain | undefined): string {
  const records = turnRecords(events);
  if (records.length === 0) return `<p class="muted">The run has no turns (it is not a consortium run): it works until a problem is settled or a budget is spent. Its account is the result above.</p>`;
  return records
    .map((record) => {
      let account: Account | undefined;
      try {
        account = buildAccount(events, record.turn, { blob: blobReader(blobs), ...(chain !== undefined ? { chain } : {}) });
      } catch {
        account = undefined;
      }
      const end = record.end;
      const head = `<h3>Turn ${record.turn}${end !== undefined ? `: ended at ${esc(end.reason)}` : ": no end in the journal"}</h3>`;
      const facts = [
        `limit ${Object.entries(record.limit).map(([k, v]) => `${v} ${k}`).join(", ") || "none"} (${esc(record.source)})`,
        end !== undefined ? `${esc(stopWords(end.reason))}: ${esc(end.detail)}` : "the process of the turn ended without writing its end",
        end !== undefined ? `spent ${money(end.spent.turn.usd)} in the turn, ${money(end.spent.run.usd)} in the run, ${end.minutes.toFixed(1)} minutes` : "",
      ].filter((x) => x !== "");
      const problems =
        account === undefined
          ? ""
          : table(
              ["Problem", "State", "Claim status", "Attempts", "Spend", "Open leaves"],
              account.problems.map((x) => [code(x.target), esc(x.state), `<span class="pill ${statusClass(x.claimStatus)}">${esc(x.claimStatus)}</span>`, String(x.attempts), money(x.spendUsd), String(x.openLeaves.length)]),
            );
      const asked = account === undefined || account.summary.asked.length === 0 ? "" : `<p><b>The team is asked:</b></p><ul>${account.summary.asked.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>`;
      const since = account === undefined || account.team.since.length === 0 ? "" : `<p><b>Answers from the team since the turn before:</b></p><ul>${account.team.since.map((a) => `<li>${esc(a.by)} (${esc(a.kind)}): ${esc(a.text)}</li>`).join("")}</ul>`;
      const narrative = account?.narrative === undefined ? "" : `<p class="muted"><b>Model-written narrative</b> (not a record: its ids resolve, its statuses are the journal's):</p><blockquote>${esc(account.narrative.text)}</blockquote>`;
      return `<section class="turn">${head}<ul>${facts.map((f) => `<li>${f}</li>`).join("")}</ul>${problems}${asked}${since}${narrative}</section>`;
    })
    .join("");
}

function spendSection(r: Result): string {
  const max = Math.max(0.000001, ...r.spend.sites.map((s) => s.usd));
  const rows = r.spend.sites.map((s) => [
    code(s.site),
    String(s.calls),
    `${money(s.usd)}<div class="bar"><div style="width:${Math.round((s.usd / max) * 100)}%"></div></div>`,
    String(s.inputTokens),
    String(s.outputTokens),
    `${(s.share * 100).toFixed(0)}%`,
  ]);
  const rungs =
    r.spend.rungs === undefined
      ? ""
      : `<p>By rung of the ladder: ${Object.entries(r.spend.rungs)
          .sort(([a], [b]) => Number(a) - Number(b))
          .map(([rung, usd]) => `rung ${esc(rung)} ${money(usd)}`)
          .join(", ")}.</p>`;
  return (
    `<p>${money(r.spend.usd)}${r.spend.budgetUsd !== undefined ? ` of ${money(r.spend.budgetUsd)}` : ""}; ${r.spend.inputTokens} input and ${r.spend.outputTokens} output tokens.` +
    `${r.spend.formalizationUsd !== undefined ? ` Formalizing the statement cost ${money(r.spend.formalizationUsd)} more, before the run.` : ""}</p>` +
    (rows.length === 0 ? `<p class="muted">Nothing was spent.</p>` : table(["Site", "Calls", "Dollars", "Input tokens", "Output tokens", "Share"], rows)) +
    rungs
  );
}

function proofSection(r: Result): string {
  const parts: string[] = [];
  if (r.certified.length === 0) parts.push(`<p>No Lean proof is certified yet. A claim is <code>proved</code> or <code>refuted</code> only when the kernel replay certified a proof.</p>`);
  for (const c of r.certified) {
    parts.push(
      `<article class="proof"><h3>${c.negation ? "Refutation" : "Proof"} of ${code(c.claimId)} <span class="pill ${c.negation ? "s-refuted" : "s-proved"}">certified</span></h3>` +
        `<p>Statement: ${code(c.statement)}</p>` +
        `<p class="muted">Kernel replay ${esc(c.validationId)}${c.attemptId !== undefined ? `, from ${esc(c.prover ?? "a prover")}, attempt ${esc(c.attemptId)}` : ""}; axioms: ${c.axioms.length === 0 ? "none" : esc(c.axioms.join(", "))}.</p>` +
        (c.file !== undefined ? pre(c.file) : `<p class="muted">The Lean file's blob is not in the run directory.</p>`) +
        `</article>`,
    );
  }
  for (const c of r.carried) parts.push(`<p>${code(c.claimId)} is <code>${esc(c.status)}</code> in the memory this run started on, not certified again by this run.</p>`);
  if (r.candidates.length > 0) {
    parts.push(`<h3>Candidates: passed the fast check, not certified</h3><p class="warn">These are not results. Until the kernel replay certifies them they may be wrong.</p>`);
    for (const c of r.candidates) {
      parts.push(`<article class="proof candidate"><h4>${code(c.claimId)} <span class="pill s-computed">candidate</span></h4><p>Statement: ${code(c.statement)}</p>${c.file !== undefined ? pre(c.file) : ""}</article>`);
    }
  }
  if (r.partial.length > 0) {
    parts.push(`<h3>Partial sketches with open holes</h3><p class="warn">Not proofs: each still has <code>sorry</code>.</p>`);
    for (const s of r.partial) {
      parts.push(`<article class="proof partial"><h4>${code(s.claimId)}: ${s.holes} open hole(s)</h4><p>Statement: ${code(s.statement)}</p>${pre(`${s.aux.trim() === "" ? "" : `${s.aux}\n\n-- proof:\n`}${s.proof}`)}${s.lastCheck !== undefined ? `<p class="muted">What Lean said of it:</p>${pre(s.lastCheck)}` : ""}</article>`);
    }
  }
  return parts.join("");
}

function evidenceSection(r: Result): string {
  const line = (c: { id: string; claimId?: string | undefined; kind: string; text: string }) => `<li>${code(c.id)}${c.claimId !== undefined ? ` (about ${code(c.claimId)})` : ""}, ${esc(c.kind)}: ${esc(c.text)}</li>`;
  return (
    (r.counterexamples.length === 0 ? "" : `<h3>Counter-examples</h3><p class="warn">Leads found by a program or a small model. A claim is <code>refuted</code> only by a certified proof of its negation.</p><ul>${r.counterexamples.map(line).join("")}</ul>`) +
    (r.evidence.length === 0 ? "" : `<h3>Indicative evidence</h3><p class="warn">Evidence, not proof: none of it changes a claim's status.</p><ul>${r.evidence.map(line).join("")}</ul>`)
  );
}

const STYLE = `
:root{--bg:#fbfbfa;--fg:#1d1f21;--muted:#62666a;--line:#d6d8da;--card:#fff;--open:#e7e9eb;--computed:#fbe9b7;--proved:#bfe6c8;--refuted:#f3c1c1;--informal:#c9dcf5;--retracted:#d9d9d9;--unknown:#eee;--accent:#245fa8}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#15171a;--fg:#e6e7e8;--muted:#9a9ea3;--line:#3a3d41;--card:#1d2024;--open:#32363a;--computed:#5b4a14;--proved:#1f5a35;--refuted:#6a2a2a;--informal:#26446f;--retracted:#3f3f3f;--unknown:#2c2f33;--accent:#7fb2ee}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1000px;margin:0 auto;padding:16px}
h1{font-size:1.5rem;margin:.4em 0}h2{font-size:1.2rem;margin:1.6em 0 .4em;border-bottom:1px solid var(--line);padding-bottom:.2em}h3{font-size:1.02rem;margin:1.2em 0 .3em}h4{margin:.8em 0 .2em}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.86em}
pre{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:10px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
code{overflow-wrap:anywhere}
.muted{color:var(--muted)}.warn{border-left:3px solid #c98a00;padding-left:8px}
.banner{border:2px solid #b00020;padding:8px 12px;border-radius:6px;margin:10px 0;font-weight:600}
.headline{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin:10px 0}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{border:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}th{background:var(--card)}
.pill{display:inline-block;border-radius:10px;padding:0 8px;font-size:.8rem;border:1px solid var(--line)}
.s-open{background:var(--open)}.s-computed{background:var(--computed)}.s-proved{background:var(--proved)}.s-refuted{background:var(--refuted)}.s-proved_informal{background:var(--informal)}.s-retracted{background:var(--retracted);text-decoration:line-through}.s-unknown{background:var(--unknown)}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;margin:8px 0;font-size:.85rem}.key{display:inline-flex;align-items:center;gap:5px}.swatch{display:inline-block;width:14px;height:14px;border:1px solid var(--line);border-radius:3px}
.graph{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--card)}svg{max-width:100%;height:auto;display:block;margin:0 auto}
.node rect{stroke:var(--line);stroke-width:1.2;fill:var(--open)}.node.s-computed rect{fill:var(--computed)}.node.s-proved rect{fill:var(--proved)}.node.s-refuted rect{fill:var(--refuted)}.node.s-proved_informal rect{fill:var(--informal)}.node.s-retracted rect{fill:var(--retracted)}
.node text{fill:var(--fg);font:11px system-ui,sans-serif}.node-id{font-family:ui-monospace,monospace!important;font-size:9.5px!important}.node-status{font-weight:700}
.edge{fill:none;stroke:var(--muted);stroke-width:1.3}.e-proposed{stroke-dasharray:5 4}.e-checked{stroke:#2e8b57;stroke-width:2}.e-signed{stroke:var(--accent);stroke-width:2}
.bar{height:6px;background:var(--line);border-radius:3px;margin-top:3px}.bar div{height:6px;background:var(--accent);border-radius:3px}
.proof{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:2px 14px 10px;margin:10px 0}.candidate{border-left:4px solid #c98a00}.partial{border-left:4px solid var(--muted)}
.turn{border:1px solid var(--line);border-radius:8px;padding:2px 14px 8px;margin:10px 0}blockquote{margin:6px 0;padding-left:10px;border-left:3px solid var(--line)}
@media (max-width:600px){main{padding:12px 16px}}
`;

export interface ViewOptions {
  /** The command that resumes the run. */
  resume?: string;
  chain?: MemoryChain | { unreadable: string };
}

/** The HTML page of a run, from the events of its journal and its blobs. */
export function buildView(events: readonly HarnessEvent[], blobs: BlobStore, options: ViewOptions = {}): string {
  const result = buildResult(events, { blob: blobReader(blobs), ...(options.chain !== undefined ? { chain: options.chain } : {}), ...(options.resume !== undefined ? { resume: options.resume } : {}) });
  const chain = options.chain !== undefined && !("unreadable" in options.chain) ? options.chain : undefined;
  const p = Projection.inMemory();
  try {
    if (chain !== undefined) p.attachChain(chain);
    for (const event of events) p.apply(event);
    const focus = result.problems.map((x) => x.claimId);
    const verified = result.journal.chain === "verified";
    const headlines = result.problems.map((x) => {
      const status = `<span class="pill ${statusClass(x.claimStatus)}">${esc(x.claimStatus)}</span>`;
      const verdict =
        x.certified && (x.claimStatus === "proved" || x.claimStatus === "refuted")
          ? `Certified by the Lean kernel.`
          : x.claimStatus === "computed"
            ? `A candidate only: it passed the fast check and is not certified.`
            : x.outcome !== undefined
              ? `Ended as ${esc(x.outcome)}${x.reason !== undefined ? `: ${esc(x.reason)}` : ""}.`
              : `No outcome in the journal yet.`;
      return `<div class="headline"><b>${code(x.target)}</b> ${status} ${verdict}</div>`;
    });
    const noCertifier = result.certifier.name === null || result.certifier.unavailable !== undefined;
    const title = result.problems.length === 1 ? `Seshat: ${result.problems[0]?.target ?? ""}` : `Seshat: run ${result.runId}`;
    const body = [
      `<h1>${esc(title)}</h1>`,
      `<p class="muted">Run ${esc(result.runId)}. ${result.state === "finished" ? "Finished" : result.state === "paused" ? "Paused, waiting for the team" : "No end in the journal"}${result.stop !== undefined ? `: ${esc(result.stop.detail)}` : ""}. ${result.journal.events} events, last hash ${esc(result.journal.head.slice(0, 16))}. Built from the journal alone: static, read-only.</p>`,
      verified ? "" : `<div class="banner">The journal's hash chain ${esc(result.journal.chain)}. Nothing on this page can be trusted until the journal is restored.</div>`,
      noCertifier ? `<div class="banner">No certifier ran${result.certifier.unavailable !== undefined ? ` (${esc(clip(result.certifier.unavailable, 240))})` : ""}: a proof that passes the fast check stays <code>computed</code>.</div>` : "",
      headlines.join(""),
      result.signature === undefined
        ? ""
        : `<h2>The statement you signed</h2><p>Signed by ${esc(result.signature.by)} (event ${result.signature.seq}).</p>${pre(result.signature.statement)}${result.signature.prose !== undefined ? `<p class="muted">From the words: ${esc(clip(result.signature.prose, 400))}</p>` : ""}`,
      `<h2>The proof</h2>${proofSection(result)}`,
      `<h2>Research graph</h2>${graph(p, focus)}<h3>Claims</h3>${claimsTable(p)}${edgesTable(p) === "" ? "" : `<h3>Edges</h3>${edgesTable(p)}`}`,
      `<h2>Turns</h2>${turnSection(events, blobs, chain)}`,
      `<h2>Spend per site and rung</h2>${spendSection(result)}`,
      evidenceSection(result) === "" ? "" : `<h2>Leads and evidence</h2>${evidenceSection(result)}`,
      `<h2>What was tried and failed</h2>${
        result.failed.length === 0 && result.errors.length === 0
          ? `<p class="muted">Nothing failed yet, or no session has ended.</p>`
          : table(["Claim", "Strategy", "Attempts", "Outcomes", "Last failure"], result.failed.map((f) => [code(f.claimId), esc(f.strategy), String(f.attempts), esc(Object.entries(f.outcomes).map(([k, n]) => `${n} ${k}`).join(", ")), esc(f.lastFailure ?? "")])) +
            (result.errors.length > 0 ? `<ul>${result.errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` : "")
      }`,
      `<h2>To continue</h2>${result.state === "finished" ? `<p>${esc(result.resume)}</p>` : pre(result.resume)}`,
    ].join("\n");
    return (
      `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">` +
      `<title>${esc(title)}</title><style>${STYLE}</style></head><body><main>\n${body}\n</main></body></html>\n`
    );
  } finally {
    p.close();
  }
}

/** Writes the page of a run directory (default `RUN_DIR/view.html`) and returns its path. */
export function writeView(dir: string, out?: string): string {
  const path = join(dir, "journal.jsonl");
  const events = readEvents(path);
  if (!events.some((e) => e.type === "run.started")) throw new Error(`${dir}: the run did not start, its journal is empty`);
  let chain: ViewOptions["chain"];
  try {
    chain = chainOfJournal(path);
  } catch (error) {
    chain = { unreadable: error instanceof Error ? error.message.slice(0, 200) : String(error) };
  }
  const lastResumed = events.findLastIndex((e) => e.type === "run.resumed");
  const finished = events.findLastIndex((e) => e.type === "run.finished") > lastResumed;
  const html = buildView(events, new BlobStore(join(dir, "blobs")), { resume: resumeCommand(dir, finished ? "finished" : "cut"), ...(chain !== undefined ? { chain } : {}) });
  const file = out ?? join(dir, "view.html");
  writeFileSync(file, html);
  return file;
}
