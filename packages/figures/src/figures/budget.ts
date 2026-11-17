import { Figure, ROLES, textLine, MUTED, INK, FAINT } from "../svg.ts";

/** The budget gate and the budget in rounds. */
export function budget(): Figure {
  const f = new Figure(
    1000,
    774,
    "The budget gate: a price against a chance, probe first",
    "No paid launch goes ahead on hope: it is priced, a cheap probe comes first, and a run's budget is shared in rounds among its problems.",
  );

  // (a) The rule.
  f.panel(24, 76, 952, 154, "(a) Before each paid launch: a price against a chance", { note: "scheduler.md, \"The budget gate\"" });
  const price = f.box(36, 104, 250, 54, {
    role: "control",
    status: "real",
    icon: "coin",
    title: "Price: the estimate",
    lines: ["mean cost of the sessions already paid", "on the problem; a first guess if none"],
    size: 10.5,
  });
  const chance = f.box(36, 164, 250, 54, {
    role: "control",
    status: "real",
    icon: "graph",
    title: "Chance: `pSuccess`",
    lines: ["a Thompson draw from the claim's", "success posterior, a Beta from n attempts"],
    size: 10.5,
  });
  const rule = f.box(310, 104, 320, 114, {
    role: "control",
    status: "real",
    strong: true,
    title: "The rule",
    lines: [
      "launch when",
      "`estimate <= share x remaining x pSuccess`",
      "`remaining`: what is left of the problem's budget",
      "`share` of a site: wave, session 0.5; task 0.25; judge 0.1",
      "the same numbers give the same answer",
    ],
    size: 10.5,
  });
  const launch = f.box(654, 104, 168, 54, {
    role: "lean",
    status: "real",
    title: "Launch",
    lines: ["the estimate is within", "the threshold: go ahead"],
    size: 10.5,
  });
  const skip = f.box(654, 164, 168, 54, {
    role: "neutral",
    status: "real",
    title: "Skip",
    lines: ["over it: skipped, and the", "row says why (`budget.gated`)"],
    size: 10.5,
  });
  const floor = f.box(844, 164, 120, 54, {
    role: "control",
    status: "real",
    title: "Floor",
    lines: ["10% of the skips", "go ahead anyway"],
    size: 10.5,
  });
  f.arrow([price.right(), [rule.x, price.cy]]);
  f.arrow([chance.right(), [rule.x, chance.cy]]);
  f.arrow([[rule.r, launch.cy], launch.left()]);
  f.arrow([[rule.r, skip.cy], skip.left()]);
  f.arrow([skip.right(), floor.left()]);
  f.arrow([floor.top(0.5), [floor.cx, launch.cy], launch.right()], { dashed: true, label: "`exploration`", labelAt: [floor.cx + 4, launch.cy - 12] });

  // (b) Probe first.
  f.panel(24, 244, 952, 206, "(b) Probe first: the fleet widens on Lean progress", { note: "scheduler.md, \"The budget gate\"" });
  const probe = f.box(36, 272, 210, 108, {
    role: "model",
    status: "real",
    icon: "model",
    title: "Probe",
    lines: ["the first prover runs one", "session under a child ledger", "of at most a tenth of the", "problem's budget (`--gate-probe`);", "its stop is a pause, not an end"],
    size: 10.5,
  });
  // The budget bar: probe, then at most one extension.
  const bx = 36;
  const bw = 210;
  f.raw(
    `<rect x="${bx}" y="398" width="${bw}" height="10" rx="3" fill="#ffffff" stroke="${ROLES.control.stroke}" stroke-width="1.2"/>` +
      `<rect x="${bx}" y="398" width="${bw * 0.1}" height="10" rx="3" fill="${ROLES.model.stroke}"/>` +
      `<rect x="${bx + bw * 0.1}" y="398" width="${bw * 0.2}" height="10" fill="${ROLES.model.stroke}" fill-opacity="0.3"/>` +
      textLine(bx, 425, "problem budget: probe, then at most one", { size: 9.5, color: MUTED }) +
      textLine(bx, 437, "extension (30% in all); the rest stays", { size: 9.5, color: MUTED }),
    "front",
  );
  const judge = f.box(280, 272, 200, 172, {
    role: "control",
    status: "real",
    strong: true,
    icon: "flag",
    title: "Lean progress?",
    lines: ["a subclaim proved, fewer open", "holes, a failed attempt deep", "enough, or the verified frontier", "grew; an accepted informal proof", "counts once, not checked by Lean"],
    size: 10.5,
  });
  const o1 = f.box(520, 272, 300, 52, {
    role: "lean",
    status: "real",
    title: "Progress: widen",
    lines: ["the other provers start and the first resumes;", "still refused if the rule finds the price too high"],
    size: 10.5,
  });
  const o2 = f.box(520, 332, 300, 52, {
    role: "model",
    status: "real",
    title: "Cut by its own cap: one extension",
    lines: ["after at least one Lean check, `probeExtend`:", "one more session, a ledger of twice the cap"],
    size: 10.5,
  });
  const o3 = f.box(520, 392, 300, 52, {
    role: "neutral",
    status: "real",
    title: "No progress: skip",
    lines: ["`by: \"progress\"`: the first prover stops with", "`gate`, the others never start (floor aside)"],
    size: 10.5,
  });
  const mem = f.box(840, 272, 124, 172, {
    role: "neutral",
    status: "real",
    title: "Memory",
    lines: ["a claim certified", "earlier (a run on", "`--memory-from`)", "is skipped:", "`by: \"memory\"`,", "no model or Lean", "call; the price", "counts as avoided"],
    size: 10.5,
  });
  f.arrow([probe.right(0.5), [judge.x, probe.cy]]);
  f.arrow([[judge.r, o1.cy], o1.left()]);
  f.arrow([[judge.r, o2.cy], o2.left()]);
  f.arrow([[judge.r, o3.cy], o3.left()]);
  void mem;

  // (c) Rounds.
  const py = 464;
  f.panel(24, py, 952, 262, "(c) A run's budget in rounds, shared among its problems", { note: "scheduler.md, \"The budget in rounds\"" });
  const x0 = 130;
  const sc = 2100; // pixels per dollar
  const X = (usd: number) => x0 + usd * sc;
  const rows: { name: string; segs: [number, number][]; end: string }[] = [
    { name: "problem 1", segs: [[0, 0.03]], end: "solved in round 0" },
    { name: "problem 2", segs: [[0, 0.05], [0.05, 0.1], [0.1, 0.17]], end: "solved in round 2" },
    { name: "problem 3", segs: [[0, 0.05]], end: "parked: no Lean progress" },
    { name: "problem 4", segs: [[0, 0.05], [0.05, 0.1]], end: "parked in round 1" },
  ];
  const tints = [ROLES.control.stroke, ROLES.model.stroke, ROLES.lean.stroke];
  const ry0 = py + 58;
  let svg = "";
  for (const [i, c] of [[0, 0.05], [1, 0.1], [2, 0.2]] as const) {
    svg += `<line x1="${X(c)}" y1="${py + 48}" x2="${X(c)}" y2="${ry0 + 4 * 26 - 6}" stroke="${FAINT}" stroke-width="1" stroke-dasharray="3 3"/>`;
    svg += textLine(X(c), py + 42, `round ${i}: $${c.toFixed(2)}`, { size: 10.5, color: MUTED, anchor: "middle" });
  }
  rows.forEach((r, i) => {
    const y = ry0 + i * 26;
    svg += textLine(36, y + 13, r.name, { size: 11, color: INK });
    r.segs.forEach(([a, b], k) => {
      svg += `<rect x="${X(a)}" y="${y}" width="${X(b) - X(a)}" height="18" fill="${tints[k]}" fill-opacity="${0.28 + 0.12 * k}" stroke="${tints[k]}" stroke-width="1.2"/>`;
    });
    const endX = X(r.segs[r.segs.length - 1]![1]);
    svg += textLine(endX + 8, y + 13, r.end, { size: 10.5, color: MUTED, halo: true });
  });
  svg +=
    textLine(36, py + 176, "A problem may have spent at most `max(runUsd / 4K, floor) x 2^r` in all by round r.", { size: 10.5, color: MUTED }) +
    textLine(36, py + 190, "Caps of the page's example ($1.35, 20 problems, $0.50 allowance); bars are illustrative.", { size: 10.5, color: MUTED });
  // The consortium stop: a turn ends at half the allowance.
  const ay = py + 236;
  const aw = 420;
  svg +=
    textLine(36, ay - 7, "Consortium stop in `solve`:", { size: 10.5, bold: true, color: ROLES.human.ink }) +
    `<rect x="${x0 + 90}" y="${ay - 18}" width="${aw - 90}" height="16" rx="3" fill="#ffffff" stroke="${ROLES.human.stroke}" stroke-width="1.2"/>` +
    `<rect x="${x0 + 90}" y="${ay - 18}" width="${(aw - 90) / 2}" height="16" rx="3" fill="${ROLES.human.stroke}" fill-opacity="0.3"/>` +
    `<line x1="${x0 + 90 + (aw - 90) / 2}" y1="${ay - 22}" x2="${x0 + 90 + (aw - 90) / 2}" y2="${ay + 2}" stroke="${ROLES.human.stroke}" stroke-width="2"/>` +
    textLine(x0 + 90 + (aw - 90) / 4, ay - 5, "spent", { size: 10, color: ROLES.human.ink, anchor: "middle" }) +
    textLine(x0 + 90 + ((aw - 90) * 3) / 4, ay - 5, "left: `harness resume`", { size: 10, color: MUTED, anchor: "middle" }) +
    textLine(x0 + 90 + (aw - 90) / 2, ay + 14, "a turn ends at half the allowance (`--turn-usd`)", { size: 10.5, color: MUTED, anchor: "middle" });
  f.raw(svg, "front");

  f.box(610, py + 36, 354, 100, {
    role: "control",
    status: "sim",
    title: "Parking",
    lines: ["at the end of a round a problem with no Lean", "progress is parked (`problem.parked`) and what", "it did not spend stays for the others; when all", "are solved or parked, the parked ones are taken", "up again, under the next, larger cap"],
    size: 10.5,
  });
  f.box(610, py + 148, 354, 100, {
    role: "control",
    status: "sim",
    title: "Share among problems: `budgetShare`",
    lines: ["a problem's cap is the smaller of `problemUsd` and", "`budgetShare` x the run budget left / the problems", "not finished; the set `v2` uses 2. Rounds act on a", "run of several problems and do nothing for one"],
    size: 10.5,
  });

  f.statusLegend(24, 748, ["real", "sim"]);
  f.legend(540, 748, [
    { role: "control", label: "budget" },
    { role: "model", label: "a model" },
    { role: "lean", label: "Lean" },
  ]);
  return f;
}
