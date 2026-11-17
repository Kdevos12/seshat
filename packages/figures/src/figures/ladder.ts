import { Figure, ROLES, textLine, MUTED, INK } from "../svg.ts";

/** The escalation ladder: a problem moves up when it spends without Lean progress. */
export function ladder(): Figure {
  const f = new Figure(
    1000,
    672,
    "The escalation ladder: dearer ideas only for stuck problems",
    "A problem moves up a rung when it has spent a share of its budget without Lean progress; problems the cheap stack solves never pay for the rungs above.",
  );

  // Top: the spend bar.
  f.panel(24, 76, 952, 124, "When a problem moves up", { note: "scheduler.md, \"The escalation ladder\"" });
  const bx = 36;
  const bw = 924;
  const by = 128;
  const bh = 30;
  const x30 = bx + bw * 0.3;
  const x60 = bx + bw * 0.6;
  const seg = (x: number, w: number, a: number, text: string) =>
    `<rect x="${x}" y="${by}" width="${w}" height="${bh}" fill="${ROLES.control.stroke}" fill-opacity="${a}" stroke="${ROLES.control.stroke}" stroke-width="1.2"/>` +
    textLine(x + w / 2, by + 19, text, { size: 11, bold: true, color: ROLES.control.ink, anchor: "middle" });
  f.raw(
    seg(bx, x30 - bx, 0.1, "rung 0: provers and the lines on from the start") +
      seg(x30, x60 - x30, 0.22, "rung 1: M18") +
      seg(x60, bx + bw - x60, 0.36, "rung 2: M15, M16") +
      // The reset arrow: Lean progress restarts the count.
      `<path d="M${bx + bw - 14},${by} V${by - 14} H${bx + 14} V${by - 3}" fill="none" stroke="${ROLES.lean.stroke}" stroke-width="1.4" stroke-dasharray="5 4" marker-end="url(#ah-2e7448)"/>` +
      textLine(bx + bw / 2, by - 11, "Lean progress (a new accepted subclaim, or fewer open holes) restarts the count", { size: 10.5, color: ROLES.lean.ink, anchor: "middle", halo: true }) +
      `<line x1="${x30}" y1="${by + bh}" x2="${x30}" y2="${by + bh + 12}" stroke="${INK}" stroke-width="1.4"/>` +
      `<line x1="${x60}" y1="${by + bh}" x2="${x60}" y2="${by + bh + 12}" stroke="${INK}" stroke-width="1.4"/>` +
      textLine(x30, by + bh + 26, "30% of the problem's budget spent since the last Lean progress", { size: 10.5, color: INK, anchor: "middle" }) +
      textLine(x30, by + bh + 40, "`ladder.escalated`, rung 0 to 1", { size: 10.5, color: MUTED, anchor: "middle" }) +
      textLine(x60, by + bh + 26, "60%: rung 1 to 2", { size: 10.5, color: INK, anchor: "middle" }) +
      textLine(x60, by + bh + 40, "`fractions`, default 0.3 and 0.6", { size: 10.5, color: MUTED, anchor: "middle" }),
    "front",
  );
  // The marker for the arrowhead colour used by the reset arrow.
  f.arrow([[0, 0], [0.1, 0]], { color: ROLES.lean.stroke, heads: "none" });

  // The rungs, side by side.
  const py = 214;
  const ph = 354;
  const pw = 292;
  const xs = [36, 352, 668];
  const p0 = f.panel(xs[0]!, py, pw, ph, "Rung 0: from the start");
  const p1 = f.panel(xs[1]!, py, pw, ph, "Rung 1: variants");
  const p2 = f.panel(xs[2]!, py, pw, ph, "Rung 2: alternatives");
  const iw = pw - 20;
  const iy = py + 30;

  // Rung 0.
  f.box(xs[0]! + 10, iy, iw, 84, {
    role: "model",
    status: "real",
    icon: "model",
    title: "Provers",
    lines: ["independent provers, in fresh", "sessions, on a Lean sketch of the", "target"],
    size: 10.5,
  });
  f.box(xs[0]! + 10, iy + 94, iw, 100, {
    role: "control",
    status: "real",
    title: "Lines with no higher rung",
    lines: ["M1 shared claims, M10 the classical", "battery, M12 holes and blueprints;", "M12 owns the ladder and the", "measure of progress"],
    size: 10.5,
  });
  f.box(xs[0]! + 10, iy + 204, iw, 110, {
    role: "neutral",
    title: "A rung counts only if its line is on",
    lines: ["a line above the problem's rung is", "idle: it gets no hook, briefing or tool", "until `ladder.escalated` moves the", "problem up"],
    size: 10.5,
  });

  // Rung 1: M18.
  f.box(xs[1]! + 10, iy, iw, 176, {
    role: "model",
    status: "sim",
    icon: "model",
    title: "M18: a curriculum of variants",
    tag: "",
    align: "start",
    lines: [
      "**1** one model request: at most 4 easier",
      "variants: `small_case`, `prime_case`,",
      "`extra_hypothesis`",
      "**2** each is a claim, `special_case_of` the",
      "target, with a `prove` task",
      "**3** inner sessions of one model call; the",
      "proof goes through `validate`",
      "**4** what Lean accepted reaches the briefings:",
      "\"Special cases already proved\"",
    ],
    size: 10.5,
  });
  f.box(xs[1]! + 10, iy + 186, iw, 62, {
    role: "control",
    status: "sim",
    title: "A capped share",
    lines: ["at most `share` = 0.2 of the problem's", "budget; spent, the open variants fail"],
    size: 10.5,
  });
  f.box(xs[1]! + 10, iy + 258, iw, 56, {
    role: "lean",
    title: "The target is untouched",
    lines: ["a variant is a claim of its own; no", "proof of it changes the target's status"],
    size: 10.5,
  });

  // Rung 2: M15 and M16.
  f.box(xs[2]! + 10, iy, iw, 150, {
    role: "model",
    status: "sim",
    icon: "graph",
    title: "M15: an archive of decompositions",
    align: "start",
    lines: [
      "several checked decompositions kept alive:",
      "one elite per cell `depth|family|region`,",
      "ranked by the share of closed leaves;",
      "Thompson sampling picks the cell a session",
      "extends, or a fresh arm; proofs that closed",
      "elsewhere are offered as schemas",
    ],
    size: 10.5,
  });
  f.box(xs[2]! + 10, iy + 160, iw, 154, {
    role: "model",
    status: "sim",
    icon: "cpu",
    title: "M16: program search",
    align: "start",
    lines: [
      "for a subgoal with a computable score, a",
      "model writes programs, kept in islands and",
      "scored in a sandbox; the score only guides",
      "the search. The best program's witness is",
      "written as a Lean term, screened, and",
      "submitted through `validate`",
    ],
    size: 10.5,
  });

  f.arrow([p0.right(0.5), p1.left(0.5)]);
  f.arrow([p1.right(0.5), p2.left(0.5)]);

  f.box(36, 582, 924, 36, {
    role: "control",
    icon: "coin",
    title: "One problem budget pays for every rung; the report lists the dollars per rung.",
    size: 10.5,
  });
  f.statusLegend(24, 644, ["real", "sim"]);
  f.legend(480, 644, [
    { role: "model", label: "a model" },
    { role: "control", label: "budget, scheduling" },
    { role: "lean", label: "Lean" },
  ]);
  return f;
}
