import { Figure, ROLES, MUTED, type Role } from "../svg.ts";

/** Line M2 as a worked example: a claim, a variant, an edge that becomes lean_checked, a composed proof, a twin, revocation. */
export function graph(): Figure {
  const f = new Figure(
    1000,
    680,
    "Graph: a result on one claim becomes a result on its neighbour",
    "Only `lean_checked` edges propagate; what a rule derives is a proposal, a composed proof that must pass `validate` like any other.",
  );
  const L = ROLES.lean;

  // (a) Four snapshots of one small graph.
  const pw = 226;
  const gap = 16;
  type Snap = {
    title: string;
    v: [string, Role, boolean];
    c: [string, Role, boolean];
    edge: [string, boolean];
    text: string[];
  };
  const snaps: Snap[] = [
    {
      title: "1 Propose",
      v: ["open", "neutral", false],
      c: ["open", "neutral", false],
      edge: ["proposed", false],
      text: ["`createVariant`: V is a claim", "of its own (`ensureClaim`), and", "`proposeEdge` writes the link", "lemma `V → C`. No status moves."],
    },
    {
      title: "2 Check the link",
      v: ["open", "neutral", false],
      c: ["open", "neutral", false],
      edge: ["lean_checked", true],
      text: ["`checkEdge` states the lemma as", "a claim; cheap tactics (`tauto`,", "`omega`...) go through `validate`;", "a valid proof checks the edge."],
    },
    {
      title: "3 Settle and propagate",
      v: ["proved", "lean", true],
      c: ["computed", "lean", false],
      edge: ["lean_checked", true],
      text: ["A prover settles V. Rule", "`strengthens/proved` derives C;", "`realize` composes a proof and", "`validate` accepts it (below)."],
    },
    {
      title: "4 Revoke",
      v: ["retracted", "control", false],
      c: ["open", "neutral", false],
      edge: ["lean_checked", true],
      text: ["V is retracted: what rested on", "it is deleted and re-derived;", "C held only by a composed proof,", "so `revokeUnsupported` reopens it."],
    },
  ];
  snaps.forEach((s, i) => {
    const x = 24 + i * (pw + gap);
    f.panel(x, 76, pw, 262, `${s.title}`);
    const bx = x + 16;
    const bw = pw - 32;
    f.box(bx, 106, bw, 50, {
      role: s.v[1],
      strong: s.v[2],
      title: `V  \`${s.v[0]}\``,
      lines: ["`n + 0 = n ∧ 0 + n = n`"],
      size: 10.5,
    });
    const cbox = f.box(bx, 202, bw, 50, {
      role: s.c[1],
      strong: s.c[2],
      title: `C  \`${s.c[0]}\``,
      lines: ["`n + 0 = n`"],
      size: 10.5,
    });
    const ax = bx + 36;
    f.arrow([[ax, 156], [ax, cbox.y]], { color: s.edge[1] ? L.stroke : "#8b94a5", dashed: !s.edge[1] });
    f.text(ax + 10, 170, "`strengthens`", { size: 10, color: MUTED });
    f.pill(ax + 10, 176, `\`${s.edge[0]}\``, { role: s.edge[1] ? "lean" : "neutral", status: s.edge[1] ? "none" : "planned", size: 10 });
    f.text(x + 14, 276, s.text, { size: 10.5 });
  });

  // (b) The composed proof of snapshot 3.
  f.panel(24, 350, 952, 134, "What `realize` composes in step 3");
  const p1 = f.box(36, 380, 340, 44, { role: "lean", title: "`aux_m2_p1`", lines: ["the proof of V, from the memory"], size: 10.5 });
  const l1 = f.box(36, 432, 340, 44, { role: "lean", title: "`aux_m2_l1`", lines: ["the link lemma `V → C`, with the proof that checked it"], size: 10.5 });
  const d1 = f.box(412, 380, 212, 96, {
    role: "control",
    title: "`aux_m2_d1`",
    lines: ["`exact L X n`:", "the step of the rule", "`strengthens/proved`,", "the submitted proof"],
    size: 10.5,
  });
  const va = f.box(660, 380, 140, 96, {
    role: "lean",
    status: "real",
    strong: true,
    icon: "lean",
    title: "`validate`",
    lines: ["the fast check"],
    size: 10.5,
  });
  const co = f.box(836, 380, 128, 96, {
    role: "lean",
    status: "real",
    title: "C `computed`",
    lines: ["`proved` once the", "certifier replays it"],
    size: 10.5,
  });
  f.arrow([p1.right(), [d1.x, p1.cy]]);
  f.arrow([l1.right(), [d1.x, l1.cy]]);
  f.arrow([d1.right(), va.left()]);
  f.arrow([va.right(), co.left()], { color: L.stroke });

  // (c) The twin.
  f.panel(24, 496, 952, 168, "The prove/refute twin");
  const prov = f.box(36, 526, 170, 40, { role: "model", title: "Provers", lines: ["try C"], size: 10.5 });
  const tw = f.box(36, 606, 170, 40, { role: "model", title: "`runTwin`", lines: ["try `¬ C`, up to N calls"], size: 10.5 });
  const cc = f.box(250, 526, 150, 40, { role: "neutral", title: "C `open`", lines: ["`n + 0 = n`"], size: 10.5 });
  const nc = f.box(250, 606, 150, 40, { role: "neutral", title: "`¬ C` `open`", lines: ["its negation, a claim"], size: 10.5 });
  f.arrow([prov.right(), cc.left()]);
  f.arrow([tw.right(), nc.left()]);
  f.arrow([cc.bottom(0.5), nc.top(0.5)], { heads: "both", color: L.stroke });
  f.text(cc.cx + 12, 590, "`negation_of`, `lean_checked`", { size: 10, color: MUTED });
  f.box(560, 526, 404, 120, {
    role: "control",
    title: "When one side settles",
    lines: [
      "`twinSettled` reads the graph: a proof of C refutes `¬ C`",
      "and a proof of `¬ C` refutes C (`negation_of/proved`,",
      "`negation_of/proved-back`); the other side stops.",
      "",
      "Framing is neutral: the model is never told whether",
      "the statement is true or false.",
    ],
    size: 10.5,
  });
  f.arrow([[cc.r, 546], [560, 546]], { color: L.stroke });
  f.arrow([[nc.r, 626], [560, 626]], { color: L.stroke });
  return f;
}
