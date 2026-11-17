import { Figure, ROLES } from "../svg.ts";

/** `harness solve`: from a statement to RESULT.md. */
export function solveLoop(): Figure {
  const f = new Figure(
    1000,
    672,
    "harness solve: from a statement to RESULT.md",
    "The statement is read, screened and signed before any spend; the run stays inside a small allowance and RESULT.md follows every result.",
  );

  // Panel 1: the statement, before any spend.
  const p1 = f.panel(24, 76, 952, 190, "Before any spend: the statement", { note: "quickstart.md, \"harness solve\"" });
  const y1 = 104;
  const h1 = 150;
  const stmt = f.box(36, y1, 100, h1, {
    role: "neutral",
    icon: "doc",
    title: "Statement",
    lines: ["a sentence,", "a Lean text,", "a `.lean`, `.txt`,", "`.md` or `.tex`", "file"],
    size: 10.5,
  });
  const read = f.box(158, y1, 140, h1, {
    role: "control",
    title: "Lean or prose?",
    lines: ["Lean when it has", "`theorem`, `lemma`,", "`import` or the shape", "`(n : ℕ) : P`;", "anything else is prose", "`--lean`, `--prose`", "force the reading"],
    size: 10.5,
  });
  const formalize = f.box(320, 160, 150, 94, {
    role: "model",
    status: "sim",
    title: "Formalize",
    lines: ["the cheapest priced", "model writes a Lean", "statement; at most 20%", "of `--max-usd`"],
    size: 10.5,
  });
  const screen = f.box(492, y1, 130, h1, {
    role: "cpu",
    status: "real",
    icon: "lock",
    title: "Strict screen",
    lines: ["every Lean text,", "yours or a model's:", "`#eval`, `run_cmd`,", "`elab`, `macro`, `IO`,", "a late `import`, any", "`#` is refused, and", "the token is named"],
    size: 10.5,
  });
  const sign = f.box(644, y1, 190, h1, {
    role: "human",
    icon: "human",
    title: "Show, test, sign",
    lines: [
      "your words beside the Lean",
      "statement; its first ten",
      "numbers tried; cheap",
      "automation: trivial as",
      "written? You answer `y`.",
      "`statement.signed` by",
      "`human:NAME`, first event",
      "after `run.started`",
    ],
    size: 10.5,
  });
  const bench = f.box(856, y1, 108, h1, {
    role: "neutral",
    status: "real",
    title: "Bench",
    lines: ["of one problem:", "`Solve.lean`,", "`index.json`", "in `RUN_DIR`", "`/problem`"],
    size: 10.5,
  });
  f.arrow([stmt.right(), read.left()]);
  f.arrow([read.right(0.14), screen.left(0.14)], { label: "Lean: shown and signed too", labelAt: [395, y1 + 12] });
  f.arrow([read.right(0.64), [formalize.x, read.y + read.h * 0.64]]);
  f.arrow([[formalize.r, read.y + read.h * 0.64], [screen.x, read.y + read.h * 0.64]]);
  f.arrow([screen.right(), sign.left()]);
  f.arrow([sign.right(), bench.left()]);

  // Panel 2: the run.
  const p2 = f.panel(24, 296, 952, 200, "The run");
  const y2 = 324;
  const h2 = 160;
  const intake = f.box(36, y2, 140, h2, {
    role: "external",
    status: "real",
    icon: "search",
    title: "Intake",
    lines: ["hygiene tests (vacuity,", "`plausible`, first cases);", "the literature only with", "your yes (`--lit`); a", "judge call capped at 5%", "of the allowance;", "evidence, no status"],
    size: 10.5,
  });
  const defaults = f.box(198, y2, 270, h2, {
    role: "control",
    status: "real",
    icon: "coin",
    title: "Student defaults (v1, v2)",
    align: "start",
    lines: [
      "**allowance**: `--max-usd`, the cap of all",
      "**model**: the cheapest that has a price",
      "**gate and probe** first (`--gate`)",
      "**lines** M1 and M10 (`--lines`)",
      "**v2** adds `lean_edit`, masked old checks,",
      "state card, Lean checks bounded to 120 s,",
      "M6 repeat rule, `probeExtend`, `lean.lsp`",
      "**turn stop** at half the allowance",
    ],
    size: 10.5,
  });
  const provers = f.box(490, y2, 150, h2, {
    role: "model",
    status: "real",
    icon: "model",
    title: "Provers",
    lines: ["fresh sessions of a", "model through its API;", "they edit a Lean file", "and call `lean_check`;", "short notes pass from", "one session to the next"],
    size: 10.5,
  });
  const fast = f.box(662, y2, 150, h2, {
    role: "lean",
    status: "real",
    icon: "lean",
    title: "Fast check",
    lines: ["Kimina REPL under a", "time bound; the first", "file with no hole that", "passes makes the claim", "`computed`, ends the", "session and stops the", "other provers"],
    size: 10.5,
  });
  const cert = f.box(834, y2, 130, h2, {
    role: "lean",
    status: "real",
    strong: true,
    icon: "lean",
    title: "Certifier",
    lines: ["kernel replay in", "a fresh, isolated", "process: the only", "way to `proved`", "or `refuted`"],
    size: 10.5,
  });
  f.arrow([bench.bottom(), [bench.cx, 281], [intake.cx, 281], intake.top()]);
  f.arrow([intake.right(), defaults.left()]);
  f.arrow([defaults.right(), provers.left()]);
  f.arrow([provers.right(), fast.left()]);
  f.arrow([fast.right(), cert.left()]);
  f.arrow([fast.top(0.3), [fast.x + fast.w * 0.3, y2 - 8], [provers.x + provers.w * 0.7, y2 - 8], [provers.x + provers.w * 0.7, y2]], {
    dashed: true,
    label: "Lean's answer",
    labelAt: [636, y2 - 18],
  });

  // Row 3: stops and RESULT.md.
  const y3 = 522;
  const stop = f.box(36, y3, 604, 78, {
    role: "control",
    icon: "clock",
    title: "A stop, not the end",
    lines: [
      "a turn ends at half the allowance (`--turn-usd`), at an impasse or when the problem is settled;",
      "or the budget runs out, or Ctrl-C. The unspent money stays yours:",
      "`harness resume RUN_DIR` spends the rest, up to the allowance.",
    ],
    size: 10.5,
  });
  const result = f.box(662, y3, 302, 78, {
    role: "neutral",
    icon: "doc",
    strong: true,
    title: "RESULT.md",
    lines: ["rewritten after every certified result", "and at every stop; built from the journal", "by code: no model, no token"],
    size: 10.5,
  });
  f.arrow([defaults.bottom(), stop.top((defaults.cx - 36) / 604)], { dashed: true, label: "sets the limit", labelAt: [defaults.cx + 38, 505], labelAnchor: "start" });
  f.arrow([provers.bottom(), [provers.cx, y3]], { label: "a limit is reached", labelAt: [provers.cx + 12, 506], labelAnchor: "start" });
  f.arrow([stop.right(), result.left()]);
  f.arrow([cert.bottom(), [cert.cx, y3]], { label: "after each result", labelAt: [cert.cx - 8, 507], labelAnchor: "end" });

  f.statusLegend(24, 628, ["real", "sim"]);
  f.legend(24, 650, [
    { role: "model", label: "a model" },
    { role: "cpu", label: "no model" },
    { role: "lean", label: "Lean" },
    { role: "external", label: "third parties" },
    { role: "human", label: "a person" },
    { role: "control", label: "budgets and stops" },
  ]);
  void ROLES;
  void p1;
  void p2;
  return f;
}
