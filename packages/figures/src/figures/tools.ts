import { Figure, ROLES } from "../svg.ts";

/** The capability registry: contract, profile, implementation, journal; levels and packs; third parties. */
export function tools(): Figure {
  const f = new Figure(
    1000,
    724,
    "Tools: every tool sits behind a capability",
    "Callers name a capability; the host profile picks the implementation, the registry checks and journals the call, and no tool sets a status.",
  );
  const T = ROLES.truth;
  const C = ROLES.control;

  // (a) One call.
  f.panel(24, 76, 952, 242, "(a) One call", { note: "profile `use`: the next implementation is tried only if one cannot be reached" });
  const man = f.box(36, 106, 200, 56, { role: "neutral", title: "`manifest.json`", lines: ["the contract: schemas, level,", "`produces`, `thirdParty`"], size: 10 });
  const con = f.box(36, 170, 200, 56, { role: "neutral", title: "`contract.json`", lines: ["golden cases, run before an", "implementation is trusted"], size: 10 });
  const hp = f.box(36, 234, 200, 56, { role: "neutral", title: "Host profile", lines: ["`use` order, settings,", "time limit, per host"], size: 10 });
  const reg = f.box(272, 106, 240, 184, {
    role: "control",
    status: "real",
    strong: true,
    title: "`registry.invoke`",
    lines: ["1 input checked against the schema", "2 third-party policy applied", "3 `tool_run.started` written", "4 implementation called, with a", "   time limit and an abort signal", "5 output checked against the schema", "6 `tool_run.finished` written"],
    size: 10.5,
  });
  f.arrow([man.right(), [reg.x, man.cy]]);
  f.arrow([con.right(), [reg.x, con.cy]]);
  f.arrow([hp.right(), [reg.x, hp.cy]]);
  const impl = [
    ["In process", ["code in the harness, built", "by a factory (`kimina`)"]],
    ["MCP, stdio", ["a program in its own process,", "any language; called, not linked"]],
    ["MCP, HTTP", ["a server reached by url;", "same contract, same checks"]],
  ] as const;
  const ib: ReturnType<Figure["box"]>[] = [];
  impl.forEach(([t, l], i) => {
    ib.push(f.box(552, 106 + i * 64, 214, 56, { role: "neutral", status: i < 2 ? "real" : "sim", title: t, lines: [...l], size: 10 }));
  });
  ib.forEach((b) => f.arrow([[reg.r, b.cy], b.left()], { heads: "both" }));
  const jb = f.box(806, 106, 158, 184, {
    role: "truth",
    status: "real",
    icon: "journal",
    title: "Journal, blobs",
    lines: ["`inputHash`", "`outputHash`", "outcome, duration", "", "inputs and outputs", "kept in `blobs/`,", "readable later"],
    size: 10.5,
  });
  f.arrow([[reg.cx, reg.b], [reg.cx, 304], [jb.cx, 304], jb.bottom()], { color: T.stroke, label: "every call, a refused one too", labelAt: [640, 304] });

  // (b) Levels and packs.
  f.panel(24, 330, 952, 212, "(b) Levels and packs");
  const lw = 300;
  const L0 = f.box(36, 356, lw, 62, { role: "neutral", title: "Level 0: `auto`", lines: ["called by the orchestrator, by rule:", "`lean.check`, `lean.certify`"], size: 10.5 });
  const L1 = f.box(36 + lw + 14, 356, lw, 62, { role: "neutral", title: "Level 1: `direct`", lines: ["about ten tools, always declared", "to the model: `compute.sage`"], size: 10.5 });
  const L2 = f.box(36 + 2 * (lw + 14), 356, lw, 62, { role: "neutral", title: "Level 2: `deferred`", lines: ["found on demand, by tool search or", "code; installed packs are here only"], size: 10.5 });
  void L0;
  void L1;
  const pw = 216;
  const py = 442;
  const ph = 88;
  const pb: ReturnType<Figure["box"]>[] = [];
  const steps: [string, string[], "control" | "neutral"][] = [
    ["`harness add PATH|URL`", ["a pack is untrusted input:", "read and checked, never", "run on install"], "neutral"],
    ["Checks", ["MCP servers only; `writesClaimStatus`", "false; `produces` at most", "`computed`; a contract case each"], "control"],
    ["`--allow-programs`", ["the programs its tools would run", "are listed; the owner accepts", "them; cases validated, not run"], "control"],
    ["Installed", ["`installed/NAME/`, recorded as", "`pack.installed` in a journal", "of its own; hash re-checked"], "neutral"],
  ];
  steps.forEach(([t, l, role], i) => {
    pb.push(f.box(36 + i * (pw + 14), py, pw, ph, { role, status: i === 0 ? "none" : "sim", title: t, lines: l, size: 10 }));
  });
  for (let i = 0; i < 3; i++) f.arrow([pb[i]!.right(), pb[i + 1]!.left()]);
  f.arrow([pb[3]!.top(0.7), [pb[3]!.x + pw * 0.7, L2.b]], { label: "evidence, never a status", labelAt: [pb[3]!.x + pw * 0.7 - 76, 431] });

  // (c) Third parties.
  f.panel(24, 554, 952, 150, "(c) Third parties: one rule, enforced by the registry before any implementation");
  const ex = ROLES.external;
  const pol = f.box(36, 584, 190, 106, {
    role: "external",
    title: "Policy",
    lines: ["from `--private` and the", "person's consent, set once;", "it only ever tightens"],
    size: 10.5,
  });
  const o1 = f.box(252, 584, 216, 106, {
    role: "external",
    title: "1 Local form",
    lines: ["the manifest has `privateInput`:", "its fields are added to the", "input, whatever the caller gave", "(`lean.search`, `lit.search`)"],
    size: 10,
  });
  const o2 = f.box(494, 584, 216, 106, {
    role: "external",
    title: "2 Non-sending only",
    lines: ["otherwise the call goes only to", "implementations that do not", "send (`decide.ask`: `faux`,", "not `jev`)"],
    size: 10,
  });
  const o3 = f.box(736, 584, 228, 106, {
    role: "neutral",
    status: "real",
    title: "3 Refused: `private`",
    lines: ["none left: no implementation", "is reached; journaled as a", "failed tool run that names", "`--private`"],
    size: 10,
  });
  f.arrow([pol.right(), o1.left()], { color: ex.stroke });
  f.arrow([o1.right(), o2.left()], { color: ex.stroke });
  f.arrow([o2.right(), o3.left()], { color: ex.stroke });
  void C;
  return f;
}
