import { Figure, ROLES, MONO, INK, MUTED, FONT, esc } from "../svg.ts";

/** The journal: a worked hash chain, the write path, resume, and carry-over between runs. */
export function journal(): Figure {
  const f = new Figure(
    1000,
    690,
    "The journal: one chain of events, everything else rebuilt",
    "Each event carries the hash of the one before; every table, report and view is a projection that can be deleted and rebuilt from it.",
  );
  const T = ROLES.truth;

  // (a) The hash chain.
  f.panel(24, 78, 952, 238, "(a) A hash chain of three events (hashes shortened, for illustration)");
  const cw = 292;
  const cy = 106;
  const ch = 134;
  const xs = [36, 354, 672];
  const cards: { type: string; actor: string; data: string[]; prev: string; hash: string }[] = [
    { type: "run.started", actor: "orchestrator", data: ["`runId`, `problems`, `host`,", "`config`"], prev: "", hash: "9f2c41" },
    { type: "claim.created", actor: "orchestrator", data: ["`claimId`, `statementId`,", "`status`: `open`"], prev: "9f2c41", hash: "5ab07e" },
    { type: "tool_run.finished", actor: "lean.check", data: ["`outcome`: `ok`,", "`outputHash`: `c81d90`"], prev: "5ab07e", hash: "e413b8" },
  ];
  cards.forEach((c, i) => {
    const x = xs[i]!;
    f.raw(
      `<rect x="${x}" y="${cy}" width="${cw}" height="${ch}" rx="6" fill="#ffffff" stroke="${T.stroke}" stroke-width="1.4"/>` +
        `<rect x="${x}" y="${cy}" width="${cw}" height="24" rx="6" fill="${T.fill}" stroke="${T.stroke}" stroke-width="1.4"/>` +
        `<rect x="${x + 1}" y="${cy + 14}" width="${cw - 2}" height="10" fill="${T.fill}"/>` +
        `<line x1="${x + 10}" x2="${x + cw - 10}" y1="${cy + 84}" y2="${cy + 84}" stroke="#d5dae2"/>`,
      "mid",
    );
    f.text(x + 10, cy + 16, `**seq ${i}**  \`${c.type}\``, { size: 11.5, color: T.ink });
    f.text(x + 10, cy + 42, `actor \`${c.actor}\``, { size: 10.5, color: MUTED });
    f.text(x + 10, cy + 58, c.data, { size: 10.5 });
    f.text(x + 10, cy + 102, `**prev**  \`${c.prev || "(empty)"}\``, { size: 10.5 });
    f.text(x + 10, cy + 122, `**hash**  \`${c.hash}\``, { size: 10.5, color: T.ink });
  });
  // The chain: hash of event i is prev of event i+1.
  for (let i = 0; i < 2; i++) {
    const x1 = xs[i]! + cw;
    const x2 = xs[i + 1]!;
    f.arrow([[x1, cy + 118], [(x1 + x2) / 2, cy + 118], [(x1 + x2) / 2, cy + 98], [x2, cy + 98]], { color: T.stroke, radius: 5 });
  }
  // The blob.
  const blob = f.box(672, 266, 292, 40, {
    role: "neutral",
    lines: ["`blobs/c8/c81d90…`: the tool's output, by its hash"],
    size: 10.5,
    radius: 5,
  });
  f.arrow([[xs[2]! + 220, cy + ch], [xs[2]! + 220, blob.y]], { color: T.stroke, dashed: true });
  f.text(36, 268, "**hash** = sha256 of the event's canonical JSON without `hash`:", { size: 10.5, color: MUTED });
  f.text(36, 283, "change, remove or reorder an event and the chain breaks; the journal then refuses to open.", { size: 10.5, color: MUTED });
  f.text(36, 298, "Large contents (files, tool inputs and outputs) live in `blobs/`; events carry their hashes.", { size: 10.5, color: MUTED });

  // (b) The write path.
  f.panel(24, 330, 952, 168, "(b) Writing: invariants first, projections after");
  const by = 366;
  const bh = 108;
  const prod = f.box(36, by, 150, bh, {
    role: "neutral",
    title: "Producers",
    lines: ["orchestrator, provers,", "validator, capabilities"],
    size: 10.5,
  });
  const inv = f.box(214, by, 196, bh, {
    role: "truth",
    status: "real",
    strong: true,
    title: "`emit` checks invariants",
    lines: ["a violation is refused and", "nothing is written: a `proved`", "with no certified validation"],
    size: 10.5,
  });
  const app = f.box(438, by, 164, bh, {
    role: "truth",
    status: "real",
    icon: "journal",
    title: "`journal.jsonl`",
    lines: ["one event per line,", "appended, hash-chained"],
    size: 10.5,
  });
  f.arrow([prod.right(), inv.left()]);
  f.arrow([inv.right(), app.left()]);
  const pp = f.panel(634, 346, 330, 144, "Projections, rebuilt from it", { role: "truth" });
  const projs = ["`projection.sqlite`", "memory store", "`RESULT.md`", "report", "view", "UI"];
  projs.forEach((p, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const w = col === 0 ? 160 : 140;
    f.pill(pp.x + 12 + (col === 0 ? 0 : 168), pp.y + 30 + row * 34, p, { role: "truth", size: 10.5, w });
  });
  f.arrow([app.right(), [pp.x, app.cy]], { color: T.stroke, dashed: true });

  // (c) Resume after a crash.
  f.panel(24, 512, 470, 150, "(c) Resume after a crash: only the journal is needed");
  const rw = 138;
  const ry = 544;
  const rh = 102;
  const r1 = f.box(36, ry, rw, rh, {
    role: "control",
    title: "Torn tail",
    lines: ["a cut last line is", "dropped; a whole", "event lacking its", "newline is kept"],
    size: 10.5,
  });
  const r2 = f.box(36 + rw + 12, ry, rw, rh, {
    role: "truth",
    title: "`run.resumed`",
    lines: ["numbered 1, 2...;", "records what was", "spent and what was", "interrupted"],
    size: 10.5,
  });
  const r3 = f.box(36 + 2 * (rw + 12), ry, rw, rh, {
    role: "control",
    title: "Close what is open",
    lines: ["tool runs, attempts:", "`aborted`; `running`", "tasks: `ready`, then", "run again"],
    size: 10.5,
  });
  f.arrow([r1.right(), r2.left()]);
  f.arrow([r2.right(), r3.left()]);

  // (d) --memory-from.
  f.panel(506, 512, 470, 150, "(d) `--memory-from`: a new run on an old one");
  const old = f.box(518, 548, 160, 98, {
    role: "truth",
    title: "Earlier journal",
    lines: ["read whole, chain", "verified, never written;", "ends at `e413b8`"],
    size: 10.5,
  });
  const nw = f.box(774, 548, 190, 98, {
    role: "truth",
    status: "real",
    title: "New `run.started`",
    lines: ["`memoryFrom`: path, run id,", "last hash `e413b8`,", "number of events"],
    size: 10.5,
  });
  f.arrow([nw.left(), old.right()], { color: T.stroke, label: ["pinned;", "checked", "at every", "open"], labelAt: [726, 596] });
  void esc;
  void MONO;
  void INK;
  void FONT;
  return f;
}
