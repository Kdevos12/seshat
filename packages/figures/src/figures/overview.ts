import { Figure, ROLES } from "../svg.ts";

/** Figure 1: Seshat at a glance. A statement goes left to right; budgets above, the journal below. */
export function overview(): Figure {
  const f = new Figure(
    1000,
    452,
    "Seshat at a glance",
    "Classical tools before any model, models only through their APIs, Lean as the only judge, and a journal that records everything.",
  );
  const y = 150;
  const h = 128;

  // Budget band, above.
  const band = f.box(24, 80, 952, 44, {
    role: "control",
    icon: "coin",
    title: "Every paid launch is priced first",
    align: "start",
  });
  f.text(band.r - 14, band.cy + 4, "a dollar allowance, a probe, a gate: price against chance of success", {
    size: 11,
    color: ROLES.control.ink,
    anchor: "end",
  });

  const stmt = f.box(24, y, 140, h, {
    role: "neutral",
    icon: "doc",
    title: "Statement",
    lines: ["in Lean or in prose;", "prose is formalized,", "shown with test cases", "and **signed** by a", "person before spend"],
  });
  const intake = f.box(184, y, 140, h, {
    role: "external",
    icon: "search",
    title: "Intake",
    lines: ["literature search:", "known? vacuous?", "false on small", "cases? evidence", "only, never a status"],
  });
  const cpu = f.box(344, y, 160, h, {
    role: "cpu",
    icon: "cpu",
    title: "Classical tools",
    lines: ["a tactic battery, SMT,", "ATPs, computer algebra,", "small models; on the", "statement and on each", "remaining `sorry`"],
  });
  const provers = f.box(524, y, 170, h, {
    role: "model",
    icon: "model",
    title: "Provers",
    lines: ["fresh sessions of a model", "through its API; they edit", "a Lean sketch, call tools,", "pass on short notes;", "no training, ever"],
  });
  const lean = f.box(764, y, 212, h, {
    role: "lean",
    icon: "lean",
    title: "Lean decides",
    strong: true,
    lines: ["**fast check** in a REPL:", "a candidate, `computed`", "**kernel replay**, fresh process:", "the only way to `proved`", "or `refuted`"],
  });

  f.arrow([stmt.right(), intake.left()]);
  f.arrow([intake.right(), cpu.left()]);
  f.arrow([cpu.right(), provers.left()]);
  f.arrow([provers.right(0.35), lean.left(0.35)], { label: ["Lean", "file"], labelAt: [729, y + 28] });
  f.arrow([lean.left(0.68), provers.right(0.68)], { label: ["errors,", "goals"], labelAt: [729, y + 108] });
  // CPU tools also hand closed goals straight to Lean.
  f.arrow(
    [cpu.bottom(0.8), [cpu.x + cpu.w * 0.8, y + h + 22], [lean.x + 40, y + h + 22], [lean.x + 40, lean.b]],
    { label: "a goal a tool closed is checked like any proof", labelAt: [612, y + h + 22] },
  );

  // Journal band, below.
  const j = f.box(24, 340, 952, 56, {
    role: "truth",
    icon: "journal",
    title: "The journal: one hash-chained JSONL file, the only source of truth",
    lines: ["every step above is an event; tables, memory, `RESULT.md`, the report and the UI are rebuilt from it, and a run resumes from it"],
  });
  for (const b of [stmt, intake, cpu, provers]) f.arrow([b.bottom(0.5), [b.cx, j.y]], { color: ROLES.truth.stroke, dashed: true });
  f.arrow([[lean.x + 150, lean.b], [lean.x + 150, j.y]], { color: ROLES.truth.stroke, dashed: true });

  f.legend(24, 424, [
    { role: "neutral", label: "input" },
    { role: "external", label: "third parties (off with --private)" },
    { role: "cpu", label: "no model" },
    { role: "model", label: "a model" },
    { role: "lean", label: "Lean" },
    { arrow: { dashed: true, color: ROLES.truth.stroke }, label: "written to the journal" },
  ]);
  return f;
}
