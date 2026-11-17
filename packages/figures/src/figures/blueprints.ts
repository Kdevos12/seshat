import { Figure } from "../svg.ts";

/** Line M12's blueprints, as a worked example: a sketch with named holes, its checks, its holes, its revisions. */
export function blueprints(): Figure {
  const f = new Figure(
    1000,
    728,
    "Blueprints: a sketch with named holes, worked one hole at a time",
    "A prover states the proof as a DAG of `sorry` holes; no model checks the plan first, small sessions fill the holes, and a planner or a repair mends a plan that falls short.",
  );

  // (a) The blueprint.
  f.panel(24, 76, 952, 232, "(a) A blueprint and the rules that accept it", { note: "scheduler.md, \"Blueprints\"" });
  const code = f.box(36, 104, 310, 138, {
    role: "neutral",
    status: "real",
    icon: "doc",
    title: "A sketch the prover writes",
    align: "start",
    lines: [
      "`lemma aux_left (n : ℕ) : 0 + n = n := by`",
      "`  sorry`",
      "`-- uses: aux_left`",
      "`lemma aux_right (n : ℕ) : n + 0 = 0 + n := by`",
      "`  sorry`",
      "`theorem solve_target ... := by`",
      "`  ... aux_right ...`",
    ],
    size: 10.5,
  });
  f.text(36, 262, ["`-- uses:` on the line directly above a hole names the", "holes its proof may use; no line, no dependency."], { size: 10.5, color: "#5b6475" });

  const nx = 392;
  const nw = 116;
  const left = f.box(nx, 112, nw, 36, { role: "model", status: "real", title: "aux_left", lines: [], size: 10.5 });
  const right = f.box(nx, 176, nw, 36, { role: "model", status: "real", title: "aux_right", lines: [], size: 10.5 });
  const target = f.box(nx, 240, nw, 44, { role: "lean", status: "real", strong: true, title: "solve_target", lines: ["the sink"], size: 10.5 });
  const extra = f.box(528, 176, 100, 44, { role: "neutral", title: "aux_extra", lines: ["dropped"], size: 10.5 });
  f.arrow([left.bottom(), right.top()], { label: "used by", labelAt: [nx + nw / 2 + 8, 162], labelAnchor: "start" });
  f.arrow([right.bottom(), target.top()], { label: "used by", labelAt: [nx + nw / 2 + 8, 226], labelAnchor: "start" });
  f.text(528, 242, ["reaches nothing: left", "out, not fatal"], { size: 10.5, color: "#5b6475" });
  void extra;

  f.box(648, 104, 316, 138, {
    role: "control",
    status: "real",
    title: "Accepted when",
    align: "start",
    lines: [
      "**1** Lean checks the file: no error (`sorry`",
      "warnings allowed)",
      "**2** every name in a `uses` line is a hole",
      "**3** no hole restates the target",
      "**4** the dependency graph has no cycle",
      "**5** at least one hole reaches the target",
    ],
    size: 10.5,
  });
  f.box(648, 250, 316, 50, {
    role: "neutral",
    title: "Refused",
    lines: ["no claim, edge or task; `healthy: false` and", "the reason (`aux_a -> aux_b -> aux_a`)"],
    size: 10.5,
  });

  // (b) The holes.
  f.panel(24, 322, 952, 214, "(b) The holes, one small session each", { note: "scheduler.md, \"Pre-flight\", \"Hole sessions\", \"Verdicts\"" });
  const by = 350;
  const bh = 172;
  const pre = f.box(36, by, 210, bh, {
    role: "cpu",
    status: "real",
    icon: "cpu",
    title: "Pre-flight: no model",
    align: "start",
    lines: [
      "**1** the hole type-checks, as",
      "`example ... := by sorry`: a gate,",
      "no compile, no session",
      "**2** the M10 battery, 30 Lean seconds",
      "**3** `plausible`: a counterexample",
      "only raises a suspicion",
      "**4** the battery on the negation",
    ],
    size: 10.5,
  });
  const sess = f.box(268, by, 230, bh, {
    role: "model",
    status: "real",
    icon: "model",
    title: "Hole session",
    align: "start",
    lines: [
      "a small file: the header, the",
      "dependencies as stubs",
      "(`lemma aux_a ... := by sorry`),",
      "and the hole; nothing else",
      "tools: `lean_check`, `lean_edit`,",
      "`hole_verdict`; 12 turns, 2 sessions",
      "per hole, priced by the gate",
    ],
    size: 10.5,
  });
  const vx = 520;
  const vw = 236;
  const v1 = f.box(vx, by, vw, 52, { role: "lean", status: "real", title: "`proved`", lines: ["work done on the stubs, or `validate`", "accepted the hole, or the battery did"], size: 10.5 });
  const v2 = f.box(vx, by + 60, vw, 52, { role: "neutral", status: "real", title: "`statement_wrong`", lines: ["a Lean-checked negation, else only a", "suspicion: no status changes"], size: 10.5 });
  const v3 = f.box(vx, by + 120, vw, 52, { role: "neutral", status: "real", title: "`too_hard`", lines: ["no proof: turns or budget ended,", "or the model said so"], size: 10.5 });
  const asm = f.box(778, by, 186, bh, {
    role: "lean",
    status: "real",
    strong: true,
    icon: "lean",
    title: "Assemble",
    lines: ["the holes' proofs in", "dependency order, under", "the link lemma of the", "target, go through", "`validate`: `computed`;", "the certifier then", "decides `proved`"],
    size: 10.5,
  });
  f.arrow([pre.right(), sess.left()]);
  for (const v of [v1, v2, v3]) f.arrow([[sess.r, v.cy], [v.x, v.cy]]);
  f.arrow([v1.right(), [asm.x, v1.cy]]);
  void v2;
  void v3;

  // (c) Revising.
  f.panel(24, 550, 952, 134, "(c) When a plan falls short", { note: "scheduler.md, \"Refinement rounds\", \"The repair pass\"" });
  const cy = 578;
  const ch = 94;
  f.box(36, cy, 454, ch, {
    role: "model",
    status: "real",
    icon: "loop",
    title: "Refinement round (`refine`)",
    align: "start",
    lines: [
      "a blueprint refused, or a hole `too_hard` or wrong: one model call, fresh context,",
      "rewrites it (site `scheduler.planner`): keep what is proved, split a hole with",
      "`-- refines: aux_old` (depth at most 3), drop or mend a wrong one. At most 8",
      "rounds, each priced by the gate; an unchanged hole keeps its claim and its proof",
    ],
    size: 10.5,
  });
  f.box(510, cy, 454, ch, {
    role: "cpu",
    status: "real",
    icon: "cpu",
    title: "Repair pass (`repair`): no model",
    align: "start",
    lines: [
      "a session ends on a file with Lean errors: each failing `aux_` proof is cut to",
      "`sorry`, a failing top-level `have` is lifted into a new hole; one check, read as",
      "a blueprint, and the M10 battery runs on every hole before any paid session",
    ],
    size: 10.5,
  });

  f.statusLegend(24, 706, ["real"]);
  f.legend(420, 706, [
    { role: "model", label: "a model" },
    { role: "cpu", label: "no model" },
    { role: "lean", label: "Lean" },
    { role: "control", label: "rules" },
  ]);
  return f;
}
