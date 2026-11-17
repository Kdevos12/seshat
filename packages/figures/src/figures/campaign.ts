import { Figure, ROLES, textLine, MUTED, INK, FAINT, RULE } from "../svg.ts";

/** `harness campaign`: turns that do not wait, a frontier read from the journal, guards, and how it ends. */
export function campaign(): Figure {
  const f = new Figure(
    1000,
    780,
    "harness campaign: a run that continues alone",
    "Turns follow each other without waiting; Lean's verified frontier is the progress meter, and only the certifier can end a campaign as settled.",
  );

  // (a) The loop and the frontier.
  f.panel(24, 76, 952, 262, "(a) Turns that do not wait, and the frontier they are judged by", { note: "campaign.md; frontier.md" });
  const y = 104;
  const h = 104;
  const w = 134;
  const b1 = f.box(36, y, w, h, {
    role: "control",
    status: "sim",
    icon: "loop",
    title: "1 Decide",
    lines: ["reads the journal:", "over? waiting for", "the day's cap or a", "usage limit? the", "turn's limit"],
    size: 10.5,
  });
  const b2 = f.box(190, y, w, h, {
    role: "model",
    status: "sim",
    icon: "model",
    title: "2 Work a turn",
    lines: ["the path of", "`harness resume`;", "sessions start cold", "from the dossier"],
    size: 10.5,
  });
  const b3 = f.box(344, y, w, h, {
    role: "control",
    status: "sim",
    icon: "doc",
    title: "3 After",
    lines: ["`digest.md` rebuilt", "by code; an impasse", "or a plateau changes", "the mode"],
    size: 10.5,
  });
  f.arrow([b1.right(), b2.left()]);
  f.arrow([b2.right(), b3.left()]);
  f.arrow([b3.bottom(), [b3.cx, y + h + 20], [b1.cx, y + h + 20], b1.bottom()], { label: "the next turn starts: nobody is asked", labelAt: [(b1.cx + b3.cx) / 2, y + h + 20] });
  f.box(36, 250, 442, 76, {
    role: "human",
    icon: "human",
    title: "A person, between turns",
    lines: ["`hint`, `sign` and `steer` tell the next turn; a question a line would ask", "goes into the digest and the work goes on. They change what sessions", "are told and the order of work, never a status"],
    size: 10.5,
  });

  // The frontier chart.
  const cx0 = 536;
  const cx1 = 948;
  const cy0 = 232;
  const cy1 = 128;
  const px = (t: number) => cx0 + t * (cx1 - cx0);
  const py = (s: number) => cy0 - s * (cy0 - cy1);
  const steps: [number, number][] = [[0, 0], [0.1, 0.1], [0.2, 0.26], [0.32, 0.4], [0.42, 0.56], [0.52, 0.74], [0.82, 0.74], [0.82, 0.92], [1, 0.92]];
  let d = `M${px(0)},${py(0)}`;
  let prev = steps[0]!;
  for (const [t, s] of steps.slice(1)) {
    d += ` L${px(t).toFixed(1)},${py(prev[1]).toFixed(1)} L${px(t).toFixed(1)},${py(s).toFixed(1)}`;
    prev = [t, s];
  }
  f.raw(
    `<rect x="${px(0.52)}" y="${cy1 - 6}" width="${px(0.82) - px(0.52)}" height="${cy0 - cy1 + 6}" fill="${ROLES.control.stroke}" fill-opacity="0.1"/>` +
      `<path d="M${cx0},${cy1 - 6} V${cy0} H${cx1}" fill="none" stroke="${FAINT}" stroke-width="1.2"/>` +
      `<path d="${d}" fill="none" stroke="${ROLES.lean.stroke}" stroke-width="2"/>` +
      `<line x1="${px(0.82)}" y1="${cy1 - 6}" x2="${px(0.82)}" y2="${cy0}" stroke="${ROLES.control.stroke}" stroke-width="1.2" stroke-dasharray="4 3"/>` +
      textLine(cx0, 118, "frontier score, from Lean's accepted facts", { size: 10.5, bold: true, color: ROLES.lean.ink }) +
      textLine(cx1, 246, "dollars spent", { size: 10.5, color: MUTED, anchor: "end" }) +
      textLine(px(0.67), 184, "no growth over", { size: 10.5, color: ROLES.control.ink, anchor: "middle" }) +
      textLine(px(0.67), 197, "`plateauUsd`", { size: 10.5, color: ROLES.control.ink, anchor: "middle" }) +
      textLine(px(0.82) - 6, 222, "`campaign.mode_changed`", { size: 10.5, color: ROLES.control.ink, anchor: "end" }),
    "front",
  );
  // The five modes, in their fixed order.
  const modes = ["specialise", "test", "construct", "read", "reformulate"];
  let mx = cx0;
  const my = 262;
  modes.forEach((m, i) => {
    const p = f.pill(mx, my, m, { role: "control", size: 10.5 });
    mx = p.r + 6;
    if (i < modes.length - 1) {
      f.raw(`<path d="M${mx - 5},${my + 10} l4,0" stroke="${INK}" stroke-width="1.2"/>`, "front");
      mx += 2;
    }
  });
  f.text(cx0, 308, ["A plateau changes the mode for a turn, by rule, no model; a mode that", "grows the frontier stays, one that adds nothing passes to the next."], { size: 10.5, color: MUTED });
  f.text(cx0 + 0, 330, [""], { size: 10 });
  f.raw(textLine(px(0.0) + 6, 247, "subclaim, reduction 3; other entries 1; evidence 0.5", { size: 9.5, color: MUTED, anchor: "start" }), "front");

  // (b) Cold restarts and guards.
  f.panel(24, 352, 952, 192, "(b) Cold restarts, and the guards", { note: "runs.md, \"Restarts\"; campaign.md, \"The dossier\", \"Guards\"" });
  f.box(36, 380, 470, 154, {
    role: "model",
    status: "sim",
    icon: "model",
    title: "A session starts cold, from a dossier",
    align: "start",
    lines: [
      "from the original file (empty AUX, the original proof), no notes;",
      "the opening message holds a dossier built by code, at most 750 tokens:",
      "**L0** the signed statement and the frontier's top entries",
      "**L2** dead ends with counts: failure class, first error, refuted subclaims",
      "**L3** unverified lessons, the first to be cut at the bound",
      "its steps follow a geometric schedule; three failures of one class on one",
      "goal end it early; `previous_attempt` shows the last file on request",
    ],
    size: 10.5,
  });
  const gx = 526;
  const gw = 438;
  f.box(gx, 380, gw, 50, {
    role: "control",
    status: "sim",
    icon: "flag",
    title: "Spiral",
    align: "start",
    lines: ["ten turns in a row that spent money in a mode and grew nothing:", "`stopped`, reason `spiral`, \"out of reach at this budget\""],
    size: 10.5,
  });
  f.box(gx, 434, gw, 50, {
    role: "human",
    status: "sim",
    icon: "lock",
    title: "A locked statement",
    align: "start",
    lines: ["no mode signs, re-signs or edits it; every goal a mode adds is a", "Lean statement or an evidence need, never prose"],
    size: 10.5,
  });
  f.box(gx, 488, gw, 50, {
    role: "lean",
    status: "sim",
    icon: "lean",
    title: "No \"done\" without Lean",
    align: "start",
    lines: ["`settled` only by the certifier's kernel replay; the frontier is", "evidence of progress, never a status"],
    size: 10.5,
  });

  // (c) How it ends.
  f.panel(24, 558, 952, 178, "(c) How it ends, and how it survives", { note: "campaign.md, \"How it ends\", \"Pacing\", \"The watchdog\"" });
  f.box(36, 596, 190, 58, {
    role: "lean",
    status: "sim",
    strong: true,
    title: "`settled`",
    lines: ["the certifier's kernel replay", "made a claim `proved`/`refuted`"],
    size: 10.5,
  });
  f.text(244, 592, "`stopped`, with the frontier and \"here is what is established\":", { size: 10.5, bold: true, color: ROLES.control.ink });
  const stops: [string, string[]][] = [
    ["`allowance`", ["the run's budget", "is spent"]],
    ["`until`", ["`--until`: the", "wall-clock end"]],
    ["`spiral`", ["no frontier growth", "over ten turns"]],
    ["`ended`", ["an error, no Lean,", "a provider refusal"]],
    ["`aborted`", ["the supervisor", "was stopped"]],
  ];
  stops.forEach(([t, lines], i) => f.box(244 + i * 144, 600, 136, 54, { role: "neutral", status: "sim", title: t, lines, size: 10.5 }));
  f.box(36, 664, 454, 52, {
    role: "control",
    status: "sim",
    icon: "clock",
    title: "Pacing",
    align: "start",
    lines: ["`--usd-per-day` pauses a day, it does not end the campaign; `--until`;", "off-peak by default"],
    size: 10.5,
  });
  f.box(510, 664, 454, 52, {
    role: "control",
    status: "sim",
    icon: "terminal",
    title: "Watchdog",
    align: "start",
    lines: ["lock and heartbeat; `harness campaign --watch` restarts a dead supervisor;", "a usage limit waits 1, 2, 4 ... 60 minutes"],
    size: 10.5,
  });
  void RULE;

  f.statusLegend(24, 756, ["sim"]);
  f.legend(330, 756, [
    { role: "model", label: "a model" },
    { role: "control", label: "supervisor, rules" },
    { role: "lean", label: "Lean" },
    { role: "human", label: "a person" },
  ]);
  return f;
}
