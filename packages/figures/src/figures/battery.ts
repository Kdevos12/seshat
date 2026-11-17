import { Figure, ROLES, MUTED, INK, textLine } from "../svg.ts";

/** Line M10: the classical battery, before any model call. */
export function battery(): Figure {
  const f = new Figure(
    1000,
    700,
    "Battery: classical tools before any model",
    "Line M10 tries the cheap tactics, then SMT and ATPs reconstructed in Lean; a win goes through `validate` and is a candidate, never a status.",
  );
  const P = ROLES.cpu;
  const L = ROLES.lean;

  // (a) Where it runs.
  f.panel(24, 76, 952, 86, "(a) Where it runs, with no model call");
  const ew = 300;
  const eb = [
    ["`beforeProvers`", "the target, then each open subgoal"],
    ["Pre-flight of a hole (M12)", "once, before its first paid session"],
    ["`sorryBattery`, off by default", "on each `sorry` a prover's check left"],
  ] as const;
  eb.forEach(([t, l], i) => {
    f.box(36 + i * (ew + 14), 104, ew, 48, { role: "cpu", status: i === 0 ? "real" : "sim", title: t, lines: [l], size: 10.5 });
  });

  // (b) One goal.
  f.panel(24, 174, 952, 252, "(b) The battery on one goal: `solveGoal`");
  const router = f.box(36, 202, 160, 208, {
    role: "cpu",
    status: "real",
    title: "Domain router",
    lines: ["reads the statement and", "names its decidable", "fragment, most specific", "first:", "`closed`, `presburger`,", "`linear_real`, `finite`,", "`polynomial_identity`,", "`first_order`, `general`"],
    size: 10,
  });
  const bat = f.panel(222, 202, 480, 208, undefined, { role: "cpu" });
  f.text(234, 222, "TACTICS ORDERED BY BETA POSTERIOR", { size: 10, bold: true, color: P.ink });
  f.text(234, 236, "prior for `polynomial_identity`, drawn by Thompson sampling", { size: 10, color: MUTED });
  const rows: [string, string, number, string][] = [
    ["`ring`", "Beta(3, 1)", 3 / 4, "first in the router's list"],
    ["`grind`", "Beta(2.5, 1)", 2.5 / 3.5, ""],
    ["`norm_num`", "Beta(2, 1)", 2 / 3, ""],
    ["rest of the list", "Beta(1.5, 1.5)", 0.5, ""],
    ["not named", "Beta(1, 2)", 1 / 3, ""],
  ];
  const bx = 330;
  const bw = 120;
  rows.forEach(([name, beta, mean], i) => {
    const y = 252 + i * 26;
    f.text(bx - 8, y + 12, name, { size: 10, anchor: "end" });
    f.raw(
      `<rect x="${bx}" y="${y}" width="${bw}" height="16" rx="3" fill="#ffffff" stroke="#c4ccd8"/>` +
        `<rect x="${bx}" y="${y}" width="${bw * mean}" height="16" rx="3" fill="${P.fill}" stroke="${P.stroke}"/>`,
      "mid",
    );
    f.raw(textLine(bx + bw + 8, y + 12, beta, { size: 10, color: MUTED }), "front");
  });
  f.text(234, 392, "the counts come from the journal (`battery_run` nodes), not from a file", { size: 10, color: MUTED });
  const rx = 540;
  f.text(rx, 262, ["**up to 4** Lean checks at once", "**60 s** of CPU in all", "the **first success** aborts", "the checks still running", "`hammer@16`, `@64`, `@256`", "when the host has it"], { size: 10.5 });
  const val = f.box(728, 202, 236, 96, {
    role: "lean",
    status: "real",
    strong: true,
    icon: "lean",
    title: "`validate`",
    lines: ["the winning proof takes the", "fast check: at most `computed`;", "a refused proof is put out"],
    size: 10.5,
  });
  const kr = f.box(728, 322, 236, 88, {
    role: "lean",
    status: "real",
    title: "Kernel replay, later",
    lines: ["only the certifier makes", "`proved`; a tool's answer alone", "never changes a status"],
    size: 10.5,
  });
  f.arrow([router.right(0.5), [bat.x, router.cy]]);
  f.arrow([[bat.r, 250], [val.x, 250]], { color: L.stroke, label: "success", labelAt: [715, 241] });
  f.arrow([val.bottom(0.5), kr.top(0.5)], { color: L.stroke });

  // (c) SMT and ATPs.
  f.panel(24, 438, 952, 158, "(c) SMT and ATPs");
  const cy = 464;
  const ch = 118;
  const c1 = f.box(36, cy, 170, ch, {
    role: "cpu",
    status: "sim",
    title: "Translate",
    lines: ["goal and premises to", "SMT-LIB and TPTP, at", "premise cutoffs 16, 64,", "256; what is outside the", "fragment is left out"],
    size: 10,
  });
  const c2 = f.box(232, cy, 170, ch, {
    role: "cpu",
    status: "sim",
    title: "z3, Vampire, E",
    lines: ["in parallel on every", "translation; the union", "of the successes is", "kept"],
    size: 10,
  });
  const c3 = f.box(428, cy, 190, ch, {
    role: "truth",
    status: "sim",
    title: "Evidence",
    lines: ["`unsat` or `Theorem`, with", "the premises of the core or", "proof, in a `first_order_run`", "node: never a status"],
    size: 10,
  });
  const c4 = f.box(644, cy, 190, ch, {
    role: "lean",
    status: "sim",
    title: "Reconstruct in Lean",
    lines: ["the premises, smallest set", "first, then the union, go to", "`grind`, `aesop` and", "`hammer`, if the host has it"],
    size: 10,
  });
  const c5 = f.box(860, cy, 104, ch, {
    role: "lean",
    status: "real",
    strong: true,
    title: "`validate`",
    lines: ["only a Lean", "proof so built", "is submitted"],
    size: 10,
  });
  f.arrow([c1.right(), c2.left()]);
  f.arrow([c2.right(), c3.left()]);
  f.arrow([c3.right(), c4.left()]);
  f.arrow([c4.right(), c5.left()], { color: L.stroke });
  f.arrow([[330, bat.b], [330, 432], [c1.x + c1.w * 0.9, 432], c1.top(0.9)]);
  f.text(262, 452, "no tactic closes it", { size: 10.5, color: MUTED, anchor: "middle" });

  // The model comes last.
  const mdl = f.box(36, 612, 928, 46, {
    role: "model",
    icon: "model",
    status: "real",
    title: "Only then a model",
    lines: ["its briefing says what was tried: the router's domain as a guess, the tactics that failed and their Lean time, what the solvers answered"],
    size: 10.5,
  });
  f.arrow([[500, 596], [500, mdl.y]]);
  f.statusLegend(24, 684, ["real", "sim"]);
  void INK;
  return f;
}
