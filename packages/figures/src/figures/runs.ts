import { Figure, ROLES, textLine, MUTED, INK } from "../svg.ts";

/** The vocabulary of runs: two axes and seven nested levels. */
export function runs(): Figure {
  const f = new Figure(
    1000,
    724,
    "Runs: two axes of shape, seven nested words",
    "A run is shaped by how long it goes (horizon) and whether it waits for a person (human); inside it, the same seven words name every level of work.",
  );

  // (a) The grid.
  f.panel(24, 76, 952, 256, "(a) The two axes: which command makes which run", { note: "runs.md, \"The two axes\"" });
  const cx = [156, 430, 704];
  const cw = 258;
  f.text(36, 124, "horizon / human", { size: 10.5, bold: true, color: MUTED });
  const heads: [string, string][] = [
    ["`none`: nobody is asked", "none"],
    ["`consortium`: waits for the team", "consortium"],
    ["`digest`: the next turn follows", "digest"],
  ];
  heads.forEach(([t], i) => f.box(cx[i]!, 104, cw, 30, { role: "human", title: t, size: 10.5 }));
  const ry = [142, 238];
  const rh = 88;
  f.box(36, ry[0]!, 108, rh, { role: "control", title: "`episode`", lines: ["a bounded number", "of sessions; it ends", "when they are used"], size: 10.5 });
  f.box(36, ry[1]!, 108, rh, { role: "control", title: "`campaign`", lines: ["money, time and a", "verified frontier", "bound it; no", "session cap"], size: 10.5 });
  const cell = (r: number, c: number, title: string, lines: string[], o: { refused?: boolean; sim?: boolean } = {}) =>
    f.box(cx[c]!, ry[r]!, cw, rh, {
      role: o.refused ? "neutral" : "model",
      status: o.refused ? "planned" : o.sim ? "sim" : "real",
      title,
      lines,
      size: 10.5,
    });
  cell(0, 0, "`harness run`", ["no turn limit: nobody is asked;", "each arm of `harness ablate`", "(a turn boundary would change", "what the models see)"]);
  cell(0, 1, "`harness solve`", ["or `harness run` with a turn limit", "or `--human`: a turn ends at a limit", "or a breakpoint and waits"]);
  cell(0, 2, "refused at the start", ["`digest` goes with `campaign`:", "a run that never waits", "for a person is a campaign"], { refused: true });
  cell(1, 0, "refused at the start", ["a campaign works in turns:", "give `digest` or `consortium`"], { refused: true });
  cell(1, 1, "`harness campaign --human`", ["turns wait for the team, as in a", "consortium run; `harness resume`", "continues it"], { sim: true });
  cell(1, 2, "`harness campaign`", ["turns follow each other alone;", "what a person would be asked", "goes into the digest"], { sim: true });

  // (b) The nesting.
  f.panel(24, 346, 952, 312, "(b) The words, each level inside the one above", { note: "runs.md, \"The levels\"" });
  const levels: { name: string; left: string; right: string }[] = [
    { name: "series", left: "runs chained by `--memory-from`, a consolidation pass between them", right: "bounded by the person" },
    { name: "run", left: "one directory, one journal, one configuration: the unit of replay", right: "its allowance: `--run-budget-usd`, `--max-usd`" },
    { name: "turn", left: "the work between two stops: a limit or breakpoint, a crash, a usage limit", right: "`--turn-usd`, `--turn-tokens`, `--turn-minutes`" },
    { name: "problem", left: "one target claim inside a run", right: "its share: `--budget-usd`, `budgetShare`" },
    { name: "child", left: "a delegated piece of work: a probe, a prover task, a hole session, a planner round", right: "a ledger carved from its parent" },
    { name: "session", left: "one fresh model context", right: "`--sessions`, `--context-tokens`" },
    { name: "step", left: "one model response", right: "`--steps`" },
  ];
  const ox = 36;
  const oy = 374;
  const ow = 928;
  const obottom = 646;
  let svg = "";
  levels.forEach((lv, i) => {
    const x = ox + i * 22;
    const w = ow - i * 44;
    const y = oy + i * 31;
    const b = obottom - i * 6;
    const isRun = lv.name === "run";
    svg += `<rect x="${x}" y="${y}" width="${w}" height="${b - y}" rx="7" fill="${i % 2 === 0 ? "#ffffff" : "#eceff3"}" stroke="${isRun ? ROLES.truth.stroke : ROLES.control.stroke}" stroke-width="${isRun ? 2.4 : 1.3}"/>`;
    svg += textLine(x + 12, y + 19, `**${lv.name}**   ${lv.left}`, { size: 10.5, color: INK });
    svg += textLine(x + w - 12, y + 19, lv.right, { size: 10.5, color: MUTED, anchor: "end" });
  });
  f.raw(svg, "mid");
  f.text(36, 678, ["Only the run has a journal (gold border): a child has none of its own and writes to the journal of the run that started it, so the truth of a run is one chain."], { size: 10.5, color: MUTED });

  f.legend(24, 704, [
    { status: "real", label: "has run for real" },
    { status: "sim", label: "built, tested with simulations only" },
    { status: "planned", label: "a combination the start refuses" },
  ]);
  return f;
}
