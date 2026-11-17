import { Figure, ROLES, type Role, type Status } from "../svg.ts";

/** The packages as layers: commands, orchestration, lines, capabilities, and the journal under all of them. */
export function architecture(): Figure {
  const f = new Figure(
    1000,
    640,
    "Architecture: the packages as layers",
    "Upper layers call lower ones; every layer writes its facts to the journal, and only Lean, at the right, changes a claim's status.",
  );
  const L = 24;
  const W = 690;

  // 1. Commands.
  const cmd = f.panel(L, 76, W, 74, "Commands", { note: "@seshat/orchestrator (cli.ts), @seshat/ui" });
  const commands = ["solve", "run", "campaign", "ablate", "resume", "consolidate", "audit", "view", "ui", "doctor"];
  let x = L + 12;
  for (const c of commands) {
    const p = f.pill(x, cmd.y + 34, c, { role: "neutral", size: 11 });
    x = p.r + 7;
  }

  // 2. Orchestration.
  const orch = f.panel(L, 162, W, 112, "Orchestration", { role: "control" });
  const ow = (W - 24 - 3 * 10) / 4;
  const o = [
    ["Orchestrator", ["the loop on pi, budgets, stops,", "resume from the journal"], "@seshat/orchestrator"],
    ["Scheduler", ["task ledger, budget gate,", "ladder, blueprints (M12)"], "@seshat/scheduler"],
    ["Fleet", ["Thompson sampling: who", "works on what; cards"], "@seshat/fleet"],
    ["Decide", ["typed choices that order work,", "never a verdict"], "@seshat/decide"],
  ] as const;
  o.forEach(([title, lines, pkg], i) => {
    const bx = L + 12 + i * (ow + 10);
    f.box(bx, orch.y + 28, ow, 74, { role: "control", status: "real", title, lines: [...lines, `\`${pkg}\``], size: 10.5 });
  });

  // 3. Lines.
  const lines = f.panel(L, 286, W, 118, "Research lines", { note: "@seshat/lines: hooks at fixed points of the loop; each one switched on alone and measured" });
  const chips: [string, string, Status][] = [
    ["M1", "shared claims", "real"],
    ["M2", "variant graph", "real"],
    ["M3", "lemma library", "sim"],
    ["M4", "context", "real"],
    ["M5", "lessons", "sim"],
    ["M6", "guards", "real"],
    ["M8", "induction", "sim"],
    ["M10", "battery", "real"],
    ["M11", "small models", "sim"],
    ["M12", "holes, ladder", "real"],
    ["M13", "theories", "sim"],
    ["M14", "repairs", "sim"],
    ["M15", "archive", "sim"],
    ["M16", "programs", "sim"],
    ["M17", "Lean env.", "sim"],
    ["M18", "curriculum", "sim"],
  ];
  const cw = (W - 24 - 7 * 8) / 8;
  chips.forEach(([id, label, status], i) => {
    const cx = L + 12 + (i % 8) * (cw + 8);
    const cy = lines.y + 30 + Math.floor(i / 8) * 42;
    f.box(cx, cy, cw, 36, { role: "neutral", status, title: id, lines: [label], size: 9.5, radius: 5 });
  });

  // 4. Capabilities.
  const caps = f.panel(L, 416, W, 128, "Capability registry", {
    note: "@seshat/registry: manifest, contract, host profile, MCP or in-process; packs at level 2",
  });
  const groups: [string, Role, [string, Status][]][] = [
    ["Lean tools", "lean", [["lean.check", "real"], ["lean.lsp", "real"], ["lean.search", "real"], ["lean.meta", "sim"], ["lean.goals", "sim"]]],
    ["Classical tools", "cpu", [["prove.auto", "sim"], ["prove.search", "sim"], ["smt.z3", "sim"], ["atp.vampire", "sim"], ["atp.eprover", "sim"], ["compute.sage", "real"]]],
    ["Third parties", "external", [["lit.search", "real"], ["oeis.search", "sim"], ["lmfdb.query", "sim"], ["findstat.identify", "sim"], ["decide.ask", "sim"]]],
  ];
  const gw = (W - 24 - 2 * 10) / 3;
  groups.forEach(([title, role, tools], i) => {
    const gx = L + 12 + i * (gw + 10);
    f.text(gx, caps.y + 40, title, { size: 11, bold: true, color: ROLES[role].ink });
    tools.forEach(([name, status], j) => {
      f.pill(gx + (j % 2) * (gw / 2 + 2), caps.y + 50 + Math.floor(j / 2) * 24, name, {
        role,
        status,
        size: 10,
        w: gw / 2 - 4,
      });
    });
  });

  // 5. The journal.
  const j = f.box(L, 556, W, 50, {
    role: "truth",
    icon: "journal",
    status: "real",
    title: "Journal and projections",
    lines: ["`@seshat/core`: events, hash chain, invariants, SQLite projection; `@seshat/memory`: claims, edges, nodes; `@seshat/graph`"],
    size: 11,
  });

  // Right column: models and Lean.
  const R = L + W + 56;
  const RW = 1000 - 24 - R;
  const model = f.box(R, 162, RW, 112, {
    role: "model",
    icon: "model",
    status: "real",
    title: "Models",
    lines: ["any provider through its API", "(pi-ai); the provers are", "pi agent sessions; Jev only", "orders work, through `decide`"],
  });
  const lean = f.box(R, 286, RW, 258, {
    role: "lean",
    icon: "lean",
    status: "real",
    strong: true,
    title: "Lean: the judge",
    lines: [
      "**fast check**: Kimina REPL;",
      "a pass makes `computed`",
      "",
      "**certifier**: `lean.certify`,",
      "`@seshat/lean-local`; kernel",
      "replay in a fresh, isolated",
      "process; the only way to",
      "`proved` and `refuted`",
      "",
      "environments as data:",
      "`@seshat/lean-env`",
    ],
  });
  const ui = f.box(R, 76, RW, 74, {
    role: "human",
    icon: "human",
    title: "People",
    lines: ["sign statements; hint, steer,", "resume; read RESULT.md"],
  });

  f.arrow([orch.right(0.6), [model.x, orch.y + orch.h * 0.6]], { heads: "both" });
  f.arrow([[caps.r, caps.y + 40], [lean.x, caps.y + 40]], { label: "checks", labelAt: [R - 28, caps.y + 32] });
  f.arrow([[lines.r, lines.cy], [lean.x, lines.cy]], { label: "validate", labelAt: [R - 28, lines.cy - 8] });
  f.arrow([[lean.cx, lean.b], [lean.cx, j.cy], [j.r, j.cy]], { color: ROLES.truth.stroke, label: ["verdicts", "as events"], labelAt: [lean.cx + 34, j.cy - 18] });
  f.arrow([[ui.x, cmd.cy], [cmd.r, cmd.cy]]);

  f.statusLegend(L, 624, ["real", "sim"]);
  return f;
}
