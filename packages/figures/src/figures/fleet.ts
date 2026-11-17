import { Figure, ROLES, textLine, MUTED, INK } from "../svg.ts";

/** The fleet and the heuristic card bank: who works on what, with which card, and whether the card helps. */
export function fleet(): Figure {
  const f = new Figure(
    1000,
    744,
    "The fleet: Thompson draws for every session, one card or none",
    "Each session's strategy, model, settings and card are drawn from what earlier attempts showed; sessions with no card are the control a card is measured against.",
  );

  // (a) The draws before a session.
  f.panel(24, 76, 952, 198, "(a) Before every session of a prover", { note: "fleet.md, \"What it decides\", \"Posteriors\", \"Soft failure memory\"" });
  const post = f.box(36, 104, 210, 154, {
    role: "truth",
    status: "sim",
    icon: "journal",
    title: "Posteriors",
    lines: ["per claim, from its attempts in", "the memory; a failure that got far", "counts partly (`choice`).", "Weight of an attempt:", "`gamma^runsAgo x probation`", "(0.8 per earlier run)"],
    size: 10.5,
  });
  const dw = 152;
  const dx = [270, 450, 630, 810];
  const dy = 104;
  const dh = 98;
  const strat = f.box(dx[0]!, dy, dw, dh, {
    role: "control",
    status: "sim",
    title: "Strategy",
    lines: ["one of M1's labels: the", "highest Thompson draw;", "with probability 0.1 a", "uniform draw, the floor"],
    size: 10.5,
  });
  const model = f.box(dx[1]!, dy, dw, dh, {
    role: "control",
    status: "sim",
    title: "Model",
    lines: ["among `models`, by a", "draw from each one's", "posterior; `escalateTo`", "after hard failures"],
    size: 10.5,
  });
  const set = f.box(dx[2]!, dy, dw, dh, {
    role: "control",
    status: "sim",
    title: "Settings",
    lines: ["`temperature` drawn in", "a range; `thinking`,", "`directive`, `mode`", "learned like a strategy"],
    size: 10.5,
  });
  const card = f.box(dx[3]!, dy, dw, dh, {
    role: "model",
    status: "sim",
    icon: "doc",
    title: "Heuristic card",
    lines: ["one card, or none: the", "control arm, drawn from", "the bank in (b)"],
    size: 10.5,
  });
  f.arrow([[post.r, strat.y + dh * 0.4], strat.left(0.4)]);
  f.arrow([strat.right(0.4), model.left(0.4)]);
  f.arrow([model.right(0.4), set.left(0.4)]);
  f.arrow([set.right(0.4), card.left(0.4)]);
  const session = f.box(810, 216, 152, 42, {
    role: "model",
    status: "sim",
    icon: "model",
    title: "Session",
    lines: ["an `allocation` node"],
    size: 10.5,
  });
  const verdict = f.box(578, 216, 190, 42, {
    role: "lean",
    status: "real",
    icon: "lean",
    title: "Lean's verdict",
    lines: ["`valid`, or how far it got"],
    size: 10.5,
  });
  f.arrow([card.bottom(0.5), session.top(0.5)]);
  f.arrow([session.left(), verdict.right()]);
  f.arrow([verdict.left(), [post.r, verdict.cy]], { label: "the attempt is counted, weighted", labelAt: [412, verdict.cy - 11] });

  // (b) The card bank.
  f.panel(24, 288, 952, 178, "(b) One card per session, or none", { note: "fleet.md, \"Heuristic cards\"; heuristics.md" });
  const by = 316;
  const bh = 112;
  const bw = 168;
  const gap = 20;
  const bx = (i: number) => 36 + i * (bw + gap);
  const b1 = f.box(bx(0), by, bw, bh, {
    role: "neutral",
    status: "sim",
    icon: "blocks",
    title: "The bank",
    lines: ["cards written by people,", "in 22 families (`vary`,", "`specialize`, `decompose`...);", "the six directives; the", "cards of packs"],
    size: 10.5,
  });
  const b2 = f.box(bx(1), by, bw, bh, {
    role: "control",
    status: "sim",
    title: "Eligible",
    lines: ["`when` holds, `whenNot`", "does not, the card agrees", "with the strategy; a card", "with a negative effect in", "the bucket is left out"],
    size: 10.5,
  });
  const b3 = f.box(bx(2), by, bw, bh, {
    role: "control",
    status: "sim",
    strong: true,
    title: "Control, first",
    lines: ["`noCardShare` = 0.2 of", "the sessions get no card:", "the control arm, recorded", "as the rule `control`"],
    size: 10.5,
  });
  const b4 = f.box(bx(3), by, bw, bh, {
    role: "control",
    status: "sim",
    title: "Family, then card",
    lines: ["Thompson draws over the", "bucket's finished attempts,", "across problems; families", "other provers hold wait;", "a new card starts at its", "family's mean"],
    size: 10.5,
  });
  const b5 = f.box(bx(4), by, bw, bh, {
    role: "model",
    status: "sim",
    icon: "doc",
    title: "One card",
    lines: ["one briefing section,", "\"Heuristic for this", "session\"; the attempt", "records the card, the rule", "and the bucket"],
    size: 10.5,
  });
  for (const [a, b] of [[b1, b2], [b2, b3], [b3, b4], [b4, b5]] as const) f.arrow([a.right(), b.left()]);
  f.arrow([b3.bottom(0.5), [b3.cx, by + bh + 14], [b5.cx, by + bh + 14], b5.bottom()], { dashed: true, label: "control: no card", labelAt: [(b3.cx + b5.cx) / 2, by + bh + 14] });

  // (c) The measurement.
  f.panel(24, 480, 952, 224, "(c) Measured against the control, never trusted", { note: "heuristics.md, \"Statistics\"" });
  const x0 = 36;
  const hy = 530;
  let svg =
    textLine(x0, hy, "bucket", { size: 10.5, bold: true, color: MUTED }) +
    textLine(x0 + 70, hy, "share of the card's", { size: 10.5, bold: true, color: MUTED }) +
    textLine(x0 + 70, hy + 12, "sessions", { size: 10.5, bold: true, color: MUTED }) +
    textLine(x0 + 214, hy, "card: valid", { size: 10.5, bold: true, color: ROLES.model.ink }) +
    textLine(x0 + 214, hy + 12, "of its sessions", { size: 10.5, bold: true, color: ROLES.model.ink }) +
    textLine(x0 + 364, hy, "control: valid", { size: 10.5, bold: true, color: MUTED }) +
    textLine(x0 + 364, hy + 12, "of its sessions", { size: 10.5, bold: true, color: MUTED });
  const rows: [string, number, number, number][] = [
    ["bucket A", 0.6, 0.55, 0.4],
    ["bucket B", 0.3, 0.3, 0.3],
    ["bucket C", 0.1, 0.15, 0.2],
  ];
  const bar = (x: number, y: number, w: number, frac: number, color: string) =>
    `<rect x="${x}" y="${y}" width="${w}" height="12" rx="3" fill="#ffffff" stroke="${color}" stroke-width="1.2"/>` +
    `<rect x="${x}" y="${y}" width="${(w * frac).toFixed(1)}" height="12" rx="3" fill="${color}" fill-opacity="0.35"/>`;
  rows.forEach(([name, share, c, k], i) => {
    const y = hy + 30 + i * 28;
    svg += textLine(x0, y + 10, name, { size: 10.5, color: INK });
    svg += bar(x0 + 70, y, 120, share, ROLES.control.stroke);
    svg += bar(x0 + 214, y, 130, c, ROLES.model.stroke);
    svg += bar(x0 + 364, y, 130, k, ROLES.control.stroke);
  });
  svg +=
    textLine(x0, hy + 128, "The control of a card's buckets is standardized to the card's own mix of buckets,", { size: 10.5, color: MUTED }) +
    textLine(x0, hy + 141, "so a card drawn mostly in hard buckets is not set against easy ones.", { size: 10.5, color: MUTED }) +
    textLine(x0, hy + 160, "Bars are illustrative.", { size: 10.5, color: MUTED, italic: true });
  f.raw(svg, "front");

  f.box(590, 508, 374, 54, {
    role: "control",
    status: "sim",
    title: "Effect",
    lines: ["two Beta posteriors, the card's sessions against", "the control: their difference and P(effect < 0)"],
    size: 10.5,
  });
  f.box(590, 570, 374, 66, {
    role: "control",
    status: "sim",
    title: "Deactivation",
    lines: ["at least 8 observations on each side and P(effect < 0)", "above 0.9: the fleet leaves the card out of the draw.", "Nothing is deleted; more control sessions can bring it back"],
    size: 10.5,
  });
  f.box(590, 644, 374, 48, {
    role: "neutral",
    status: "sim",
    title: "Read, by family and by card",
    lines: ["`harness heuristics stats RUN_DIR`: no model is called"],
    size: 10.5,
  });

  f.statusLegend(24, 726, ["real", "sim"]);
  f.legend(540, 726, [
    { role: "truth", label: "journal, memory" },
    { role: "control", label: "draws" },
    { role: "model", label: "a model" },
    { role: "lean", label: "Lean" },
  ]);
  return f;
}
