import { Figure, ROLES, textLine, MUTED, INK, FAINT } from "../svg.ts";

/** How a prover works against context rot: fresh sessions, a small carry, small edits, masked old checks. */
export function sessions(): Figure {
  const f = new Figure(
    1000,
    688,
    "A prover in fresh sessions: the context never rots",
    "Each session starts empty from the file as left, short notes and a state card; inside a session, edits are small and old check results are masked.",
  );

  // Panel A: across sessions.
  f.panel(24, 76, 952, 304, "Across sessions: a fresh context each time", { note: "m0-loop.md, \"A prover\" and \"The state card\"" });
  const sy = 104;
  const sh = 128;
  const sw = 270;
  const xs = [36, 365, 694];
  const defs: [string, string[], number][] = [
    ["Session 1", ["a fresh context. The opening message", "holds the theorem, the file (at first", "`sorry`) and what Lean said of it"], 0.5],
    ["Session 2", ["a fresh context again, opened with the", "file as the last check left it, the model's", "notes and, in `v2`, the state card"], 0.7],
    ["Session k", ["the same, until a check passes, or `turns`,", "`context`, the budget or the sessions run", "out: `stoppedBy` in `attempt.finished`"], 0.9],
  ];
  const boxes = defs.map(([title, lines, fill], i) => {
    const x = xs[i]!;
    const b = f.box(x, sy, sw, sh, { role: "model", status: "real", icon: "model", title, lines, size: 10.5 });
    // The context bar: it fills with checks and is thrown away at the end of the session.
    const bx = x + 12;
    const by = sy + sh - 16;
    const bw = sw - 24;
    f.raw(
      `<rect x="${bx}" y="${by}" width="${bw}" height="8" rx="4" fill="#ffffff" stroke="${ROLES.model.stroke}" stroke-width="1"/>` +
        `<rect x="${bx}" y="${by}" width="${(bw * fill).toFixed(1)}" height="8" rx="4" fill="${ROLES.model.stroke}" fill-opacity="0.35"/>` +
        [0.12, 0.27, 0.4, 0.55, 0.7, 0.85]
          .filter((t) => t < fill)
          .map((t) => `<line x1="${(bx + bw * t).toFixed(1)}" y1="${by}" x2="${(bx + bw * t).toFixed(1)}" y2="${by + 8}" stroke="${ROLES.model.stroke}" stroke-width="1.4"/>`)
          .join("") +
        textLine(bx + bw, by - 4, "context, with its checks", { size: 9.5, color: MUTED, anchor: "end" }),
      "front",
    );
    return b;
  });
  f.arrow([boxes[0]!.right(0.4), boxes[1]!.left(0.4)]);
  f.arrow([boxes[1]!.right(0.4), boxes[2]!.left(0.4)]);

  // The journal band that carries what the next session starts from.
  const jy = 262;
  const band = f.panel(36, jy, 928, 106, "Journal: what the next session starts from", { role: "truth" });
  const cw = 290;
  const cy = jy + 28;
  const ch = 66;
  f.box(48, cy, cw, ch, {
    role: "truth",
    icon: "doc",
    title: "The file as left",
    lines: ["the AUX and PROOF regions of the last check", "and the text of that check, as blobs"],
    size: 10.5,
  });
  f.box(48 + cw + 16, cy, cw, ch, {
    role: "truth",
    icon: "journal",
    title: "Notes: `lesson.recorded`",
    lines: ["the model's last message, rewritten in full", "and cut at `notesChars`; 1500 characters", "when the card is on"],
    size: 10.5,
  });
  f.box(48 + 2 * (cw + 16), cy, cw, ch, {
    role: "truth",
    icon: "graph",
    title: "State card (`v2`)",
    lines: ["built from the journal by code, no model:", "goal, holes, accepted lemmas, failed", "approaches with counts, timeouts"],
    size: 10.5,
  });
  const down = (i: number) => boxes[i]!.bottom(0.9);
  const up = (i: number) => boxes[i]!.bottom(0.1);
  for (const i of [0, 1]) {
    f.arrow([down(i), [down(i)[0], jy]], { color: ROLES.truth.stroke, label: "carry out", labelAt: [down(i)[0] + 6, 248], labelAnchor: "start" });
    f.arrow([[up(i + 1)[0], jy], up(i + 1)], { color: ROLES.truth.stroke, label: "carry in", labelAt: [up(i + 1)[0] + 6, 248], labelAnchor: "start" });
  }
  void band;

  // Panel B: inside a session.
  const py = 394;
  f.panel(24, py, 952, 232, "Inside a session", { note: "m0-loop.md, \"The edit tool\", \"Masked old checks\"; lean.md, \"Bounded checks\"" });
  const iy = py + 30;

  // Edit tool.
  const edit = f.box(36, iy, 290, 100, {
    role: "neutral",
    icon: "terminal",
    title: "`lean_edit(region, old, new)`",
    lines: ["patches the region as last checked; `old` must", "occur exactly once, else `not found` or", "`found N times` and nothing is checked.", "On success it runs the same check as", "`lean_check`, and the journal is unchanged"],
    size: 10.5,
  });
  f.text(36, iy + 118, ["Why: output tokens were about 90% of the dollars", "of the first real runs, the file being rewritten", "whole at every check."], { size: 10.5, color: MUTED });

  // Masked old checks: a strip of twelve check results.
  const mx = 346;
  const mw = 300;
  f.text(mx, iy + 10, "What the model is sent of 12 checks", { size: 11, bold: true, color: INK });
  const cellW = 18;
  const gap = 6;
  const base = iy + 78;
  const startX = mx + (mw - (12 * cellW + 11 * gap)) / 2;
  let strip = "";
  for (let i = 0; i < 12; i++) {
    const x = startX + i * (cellW + gap);
    const whole = i >= 8;
    const h = whole ? 46 : 12;
    strip += `<rect x="${x}" y="${base - h}" width="${cellW}" height="${h}" rx="3" fill="${whole ? ROLES.lean.fill : "#eceff3"}" stroke="${whole ? ROLES.lean.stroke : FAINT}" stroke-width="1.2"/>`;
  }
  const xm0 = startX;
  const xm1 = startX + 8 * cellW + 7 * gap + cellW;
  const xw0 = startX + 8 * (cellW + gap);
  const xw1 = startX + 11 * (cellW + gap) + cellW;
  strip +=
    `<path d="M${xm0},${base + 6} v4 H${xm1} v-4" fill="none" stroke="${MUTED}" stroke-width="1.2"/>` +
    `<path d="M${xw0},${base + 6} v4 H${xw1} v-4" fill="none" stroke="${ROLES.lean.stroke}" stroke-width="1.2"/>` +
    textLine((xm0 + xm1) / 2, base + 24, "8 oldest: one line each", { size: 10.5, color: MUTED, anchor: "middle" }) +
    textLine((xw0 + xw1) / 2, base + 24, "last 4: whole", { size: 10.5, color: ROLES.lean.ink, anchor: "middle" });
  f.raw(strip, "mid");
  f.text(mx, iy + 130, ["`Earlier check, masked: 3 error(s), 0 hole(s).`", "In batches of four, so the cached prefix survives;", "none masked below 8 results. The journal keeps all."], { size: 10.5, color: MUTED });

  // Bounded check and success.
  const rx = 666;
  const rw = 298;
  const bound = f.box(rx, iy, rw, 100, {
    role: "lean",
    status: "real",
    icon: "clock",
    title: "A bounded Lean check",
    lines: ["`lean_check` and `lean_edit` end in the fast check,", "bounded at the host's `checkTimeoutSec` (120 s):", "\"did not finish\" costs one turn, not 300 s.", "A check with holes or without an answer is no", "validation"],
    size: 10.5,
  });
  const win = f.box(rx, iy + 116, rw, 72, {
    role: "lean",
    status: "real",
    strong: true,
    icon: "lean",
    title: "A first valid check wins",
    lines: ["`validation.finished`: the claim is `computed`;", "the session ends, the problem's other", "provers abort; the certifier decides"],
    size: 10.5,
  });
  f.arrow([bound.bottom(0.5), win.top(0.5)]);
  f.statusLegend(24, 654, ["real"]);
  f.legend(330, 654, [
    { role: "model", label: "a model" },
    { role: "lean", label: "Lean" },
    { role: "truth", label: "journal" },
  ]);
  return f;
}
