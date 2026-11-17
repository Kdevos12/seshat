import { Figure, ROLES, textLine, MUTED, INK, FAINT } from "../svg.ts";

/** The measurement protocol: harness ablate, cumulative arms, a paired comparison, a graded bench admitted by Lean. */
export function ablation(): Figure {
  const f = new Figure(
    1000,
    792,
    "Measuring a line: same problems, same dollars, paired",
    "`harness ablate` adds one line at a time to the ones before it, runs every arm on the same admitted problems at the same budget, and compares the arms pair by pair.",
  );

  // (a) The arms.
  f.panel(24, 76, 952, 240, "(a) One line added at a time, everything else equal", { note: "ablate.md, \"The configurations and the runner\"" });
  const prob = f.box(36, 104, 220, 120, {
    role: "neutral",
    status: "real",
    icon: "doc",
    title: "The same problems",
    lines: ["a sample of the graded bench", "(c), the same seed for every arm;", "the same budget: providers,", "sessions, dollars per problem"],
    size: 10.5,
  });
  f.box(36, 236, 220, 68, {
    role: "control",
    status: "real",
    icon: "lock",
    title: "Nobody is asked",
    lines: ["`human: none`: turns and a", "person are refused, a turn", "boundary changes what models see"],
    size: 10.5,
  });
  const rows: { name: string; chips: string[]; text?: string }[] = [
    { name: "M0", chips: [], text: "no line: the baseline" },
    { name: "M1", chips: ["M1"] },
    { name: "M10", chips: ["M1", "M10"] },
    { name: "...", chips: [], text: "each next line in turn, M7 and M9 aside" },
  ];
  const rx = 292;
  const rw = 372;
  let svg = "";
  rows.forEach((r, i) => {
    const y = 104 + i * 48;
    svg += `<rect x="${rx}" y="${y}" width="${rw}" height="40" rx="6" fill="#ffffff" stroke="${ROLES.neutral.stroke}" stroke-width="1.3"/>`;
    svg += textLine(rx + 12, y + 25, r.name, { size: 12, bold: true, color: INK });
    if (r.text) svg += textLine(rx + 70, y + 25, r.text, { size: 10.5, color: MUTED, italic: true });
  });
  svg += `<path d="M${rx - 2},106 H${rx - 14} V286 H${rx - 2}" fill="none" stroke="${MUTED}" stroke-width="1.3"/>`;
  svg += `<path d="M${rx + rw + 2},106 H${rx + rw + 14} V286 H${rx + rw + 2}" fill="none" stroke="${MUTED}" stroke-width="1.3"/>`;
  f.raw(svg, "mid");
  rows.forEach((r, i) => {
    const y = 104 + i * 48;
    r.chips.forEach((c, k) => f.pill(rx + 70 + k * 66, y + 9, c, { role: "control", w: 58 }));
  });
  f.text(rx, 308, "cumulative: each arm holds the lines of the arms above it", { size: 10.5, color: MUTED });
  f.arrow([prob.right(0.5), [rx - 14, prob.cy]]);
  const jr = f.box(704, 104, 260, 120, {
    role: "truth",
    icon: "journal",
    title: "A journal for each arm",
    lines: ["`arms/NAME/measure`: an arm is", "a run of its own; every number is", "read from the journals, by a pure", "function of events (`measureRun`)"],
    size: 10.5,
  });
  f.arrow([[rx + rw + 14, jr.cy], jr.left()]);
  f.box(704, 236, 260, 68, {
    role: "neutral",
    status: "real",
    title: "One row per arm",
    lines: ["solved, dollars per solve, context,", "memory use, spend by site, cache..."],
    size: 10.5,
  });
  f.arrow([jr.bottom(0.5), [jr.cx, 236]]);

  // (b) The paired protocol.
  f.panel(24, 330, 952, 236, "(b) The paired protocol", { note: "ablate.md, \"The paired protocol\"" });
  const gx = 36;
  const gy = 366;
  let g =
    textLine(gx, gy, "problem", { size: 10.5, bold: true, color: MUTED }) +
    textLine(gx + 112, gy, "baseline", { size: 10.5, bold: true, color: MUTED, anchor: "middle" }) +
    textLine(gx + 182, gy, "arm", { size: 10.5, bold: true, color: MUTED, anchor: "middle" });
  const data: [boolean, boolean][] = [[true, true], [false, true], [false, false], [true, false], [false, true], [true, true]];
  data.forEach(([b, a], i) => {
    const y = gy + 12 + i * 24;
    const disc = b !== a;
    if (disc) g += `<rect x="${gx - 4}" y="${y - 2}" width="250" height="22" rx="4" fill="${ROLES.truth.fill}" stroke="${ROLES.truth.stroke}" stroke-opacity="0.5" stroke-width="1"/>`;
    g += textLine(gx + 4, y + 14, `p${i + 1}`, { size: 10.5, color: INK });
    for (const [cx, v] of [[gx + 112, b], [gx + 182, a]] as const)
      g += `<circle cx="${cx}" cy="${y + 9}" r="6" fill="${v ? ROLES.lean.stroke : "#ffffff"}" stroke="${v ? ROLES.lean.stroke : FAINT}" stroke-width="1.4"/>`;
    if (disc) g += textLine(gx + 226, y + 14, b ? "c" : "b", { size: 11, bold: true, color: ROLES.truth.ink, anchor: "middle" });
  });
  g +=
    textLine(gx, gy + 166, "filled: solved by Lean (illustrative); a pair is", { size: 10.5, color: MUTED }) +
    textLine(gx, gy + 180, "one problem in both arms. `b`: only the arm", { size: 10.5, color: MUTED }) +
    textLine(gx, gy + 194, "solved it; `c`: only the baseline", { size: 10.5, color: MUTED });
  f.raw(g, "mid");

  f.box(300, 358, 330, 98, {
    role: "control",
    status: "real",
    title: "Per arm",
    align: "start",
    lines: ["problems solved of N, with the Wilson interval (95%)", "dollars spent, per solved problem, and problems", "solved per dollar", "wall-clock time; certified refutations counted apart"],
    size: 10.5,
  });
  f.box(300, 464, 330, 90, {
    role: "control",
    status: "real",
    title: "Against the baseline",
    align: "start",
    lines: ["the discordant pairs `b` and `c`; the exact two-sided", "McNemar test; the ratio of problems solved per dollar,", "arm over baseline, on problems both finished. Arms that", "did not finish the same problems: no verdict"],
    size: 10.5,
  });

  // The target line.
  const ax0 = 666;
  const unit = 116;
  const X = (r: number) => ax0 + r * unit;
  const ay = 478;
  f.raw(
    textLine(ax0, 372, "The target line", { size: 11.5, bold: true, color: INK }) +
      `<rect x="${X(1.5)}" y="384" width="${X(2.5) - X(1.5)}" height="${ay - 384}" fill="${ROLES.lean.fill}" stroke="${ROLES.lean.stroke}" stroke-opacity="0.5"/>` +
      `<line x1="${X(1)}" y1="384" x2="${X(1)}" y2="${ay}" stroke="${MUTED}" stroke-width="1.3" stroke-dasharray="4 3"/>` +
      `<line x1="${X(1.5)}" y1="384" x2="${X(1.5)}" y2="${ay}" stroke="${ROLES.lean.stroke}" stroke-width="2"/>` +
      `<line x1="${ax0}" y1="${ay}" x2="${X(2.5)}" y2="${ay}" stroke="${FAINT}" stroke-width="1.3"/>` +
      [0, 1, 2].map((t) => `<line x1="${X(t)}" y1="${ay}" x2="${X(t)}" y2="${ay + 4}" stroke="${FAINT}" stroke-width="1.3"/>` + textLine(X(t), ay + 16, String(t), { size: 10.5, color: MUTED, anchor: "middle" })).join("") +
      textLine(X(1) - 5, 398, "baseline", { size: 10.5, color: MUTED, anchor: "end" }) +
      textLine(X(1.5) + 6, 398, "`--target` 1.5", { size: 10.5, color: ROLES.lean.ink, anchor: "start" }) +
      `<circle cx="${X(1.85)}" cy="430" r="6" fill="${ROLES.lean.stroke}"/>` +
      textLine(X(1.85), 452, "an arm", { size: 10.5, color: ROLES.lean.ink, anchor: "middle" }) +
      textLine(ax0, ay + 34, "problems solved per dollar, arm over baseline (illustrative)", { size: 10.5, color: MUTED }),
    "mid",
  );
  f.text(ax0, 530, ["`Target met`: the best arm's ratio reaches the", "target and it solves no fewer problems than", "the baseline; otherwise `Target not met`"], { size: 10.5, color: INK });

  // (c) The yardstick.
  f.panel(24, 580, 952, 174, "(c) The yardstick: a graded bench, each statement admitted by Lean", { note: "bench.md, \"The graded bench\"" });
  const gradeBoxes: [string, string[], number][] = [
    ["A: exercises", ["formal-conjectures `textbook` and `test`", "theorems; admitted: 111 of 111"], 36],
    ["B: competition", ["PutnamBench, a seeded sample of 100;", "admitted: 20 of 326 candidates"], 350],
    ["C: research", ["formal-conjectures with a formal proof", "elsewhere, up to 70; admitted: 10 of 70"], 664],
  ];
  const boxes = gradeBoxes.map(([t, l, x]) => f.box(x, 608, 300, 62, { role: "neutral", status: "real", title: t, lines: l, size: 10.5 }));
  const adm = f.box(36, 690, 928, 52, {
    role: "lean",
    status: "real",
    strong: true,
    icon: "lean",
    title: "Admission by the real Lean",
    lines: ["a statement is admitted only if it compiles with `sorry` as its proof; one Lean cannot read is replaced, never counted as unsolved;", "problems tagged `small_budget_out_of_reach` are reported apart, and the verdicts use the problems in reach"],
    size: 10.5,
  });
  for (const b of boxes) f.arrow([b.bottom(), [b.cx, adm.y]]);

  f.statusLegend(24, 770, ["real"]);
  f.legend(540, 770, [
    { role: "control", label: "protocol" },
    { role: "truth", label: "journals" },
    { role: "lean", label: "Lean" },
  ]);
  return f;
}
