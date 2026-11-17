import { Figure, ROLES, MUTED } from "../svg.ts";

/** The memory store: the one interface lines read and write, what it holds, stamps, draws, carry-over. */
export function memory(): Figure {
  const f = new Figure(
    1000,
    780,
    "Memory: one interface over the journal",
    "Lines read and write claims, edges and nodes only through the store; unverified records are stamped, drawn at random and judged by effect.",
  );
  const T = ROLES.truth;

  // (a) The interface.
  f.panel(24, 76, 952, 144, "(a) One interface: `MemoryStore`");
  const lines = f.box(36, 104, 190, 92, {
    role: "control",
    title: "Lines, orchestrator",
    lines: ["a line gets a view:", "`withActor(\"line:M1\")`;", "none holds the journal"],
    size: 10.5,
  });
  const store = f.box(266, 104, 260, 92, {
    role: "truth",
    status: "real",
    strong: true,
    title: "`MemoryStore`",
    lines: ["`ensureClaim`, `addEdge`, `recordNode`,", "`updateNode`, `retractClaim`, `draw`;", "reads: claims, edges, nodes, attempts"],
    size: 10.5,
  });
  const jr = f.box(566, 104, 170, 92, {
    role: "truth",
    status: "real",
    icon: "journal",
    title: "Journal",
    lines: ["one event per write,", "invariants checked", "before it is appended"],
    size: 10.5,
  });
  const pj = f.box(776, 104, 188, 92, {
    role: "truth",
    status: "real",
    title: "`projection.sqlite`",
    lines: ["rebuilt from the journal;", "every read comes from it"],
    size: 10.5,
  });
  f.arrow([lines.right(), store.left()], { heads: "both" });
  f.arrow([store.right(), jr.left()], { color: T.stroke });
  f.arrow([jr.right(), pj.left()], { color: T.stroke });
  f.arrow([pj.bottom(0.5), [pj.cx, 208], [store.cx, 208], store.bottom(0.5)], { color: T.stroke, dashed: true, label: "reads", labelAt: [640, 208] });

  // (b) What it holds.
  f.panel(24, 232, 952, 196, "(b) What it holds");
  const A = f.box(48, 266, 220, 52, { role: "lean", status: "real", title: "claim `proved`", lines: ["`(n : ℕ) : n + 0 = n`"], size: 10.5 });
  const B = f.box(48, 366, 220, 52, { role: "neutral", title: "claim `open`", lines: ["`: 0 + 0 = 0`, a variant"], size: 10.5 });
  f.arrow([B.top(0.75), A.bottom(0.75)], { color: ROLES.lean.stroke });
  f.pill(224, 332, "`lean_checked`", { role: "lean", size: 10 });
  f.text(205, 346, "`special_case_of`", { size: 10, color: MUTED, anchor: "end" });
  const N1 = f.box(336, 266, 232, 52, { role: "neutral", status: "sim", title: "node `lesson`", lines: ["about the claim; `learned`, stamped"], size: 10.5 });
  const N2 = f.box(336, 366, 232, 52, { role: "neutral", status: "sim", title: "node `fingerprint`", lines: ["`data`: JSON; large parts in blobs"], size: 10.5 });
  f.arrow([N1.left(), A.right()], { color: "#8b94a5", dashed: true, label: "`claimId`", labelAt: [302, 284] });
  f.arrow([N2.left(), B.right()], { color: "#8b94a5", dashed: true, label: "`claimId`", labelAt: [302, 384] });
  const rx = 612;
  f.text(rx, 262, "**Claims**: one per statement id, a hash of the statement and its", { size: 10.5 });
  f.text(rx, 276, "header (same hash, same claim); a status that only Lean raises.", { size: 10.5 });
  f.text(rx, 308, "**Edges**: 11 kinds (`implies`, `equiv`, `special_case_of`...);", { size: 10.5 });
  f.text(rx, 322, "`proposed`, `computed`, `informal_checked`, `human_signed`,", { size: 10.5 });
  f.text(rx, 336, "`lean_checked`: only the last propagates proofs.", { size: 10.5 });
  f.text(rx, 368, "**Nodes**: any lowercase kind (`lemma`, `lesson`...); the package", { size: 10.5 });
  f.text(rx, 382, "that owns a kind owns its `data`; edits are JSON merge patches;", { size: 10.5 });
  f.text(rx, 396, "nobody edits a `hint` or a `steer`.", { size: 10.5 });

  // (c) Provenance and epochs.
  f.panel(24, 440, 466, 176, "(c) Provenance and epochs");
  f.box(36, 468, 216, 136, {
    role: "neutral",
    title: "Unverified: stamped",
    lines: ["lesson, attempt record,", "posterior, learned node:", "`modelId`, `promptVersion`,", "`mathlibRev`, `harnessVersion`,", "`budgetClass`, `createdAt`"],
    size: 10.5,
  });
  f.box(264, 468, 214, 48, { role: "lean", status: "real", title: "Verified: no stamp", lines: ["proved claim, `lean_checked` edge"], size: 10 });
  const ep = f.box(264, 528, 214, 76, {
    role: "control",
    title: "New epoch: probation",
    lines: ["model family, prompt major or", "Mathlib revision changes: old", "counters shrink, `k` = 0.25"],
    size: 10.5,
  });
  void ep;

  // (d) Randomized inclusion.
  f.panel(506, 440, 470, 176, "(d) Randomized inclusion");
  const it = f.box(518, 466, 128, 78, {
    role: "neutral",
    title: "Items a line chose",
    lines: ["claims and verified", "facts are never drawn,", "always shown"],
    size: 10,
  });
  const dr = f.box(670, 466, 136, 78, {
    role: "truth",
    status: "real",
    title: "`draw`, seeded",
    lines: ["in with `pNew` 0.5,", "`p` 0.9 after 20 uses", "in the epoch"],
    size: 10,
  });
  const inc = f.box(834, 466, 130, 36, { role: "lean", title: "included: shown", size: 10 });
  const wit = f.box(834, 508, 130, 36, { role: "neutral", title: "withheld", size: 10 });
  f.arrow([it.right(), dr.left()]);
  f.arrow([dr.right(0.3), inc.left()]);
  f.arrow([dr.right(0.7), wit.left()]);
  const eff = f.box(518, 564, 446, 42, {
    role: "control",
    lines: ["**effect** = success rate with the item vs without, two Beta posteriors;", "deactivate when P(effect < 0) > 0.9 after enough observations"],
    size: 10.5,
  });
  f.arrow([[wit.cx, wit.b], [wit.cx, eff.y]]);
  f.text(wit.cx - 8, 558, "both lists on `attempt.started`", { size: 9.5, color: MUTED, anchor: "end" });

  // (e) Across runs.
  f.panel(24, 628, 952, 122, "(e) Memory across runs: `--memory-from`, pinned by the earlier journal's last hash");
  const ew = 300;
  f.box(36, 656, ew, 84, {
    role: "lean",
    title: "Same Lean environment (equal hash)",
    lines: ["claims keep their status, validations", "count, `lean_checked` edges propagate"],
    size: 10.5,
  });
  f.box(36 + ew + 16, 656, ew, 84, {
    role: "control",
    title: "Another or unknown environment",
    lines: ["claims `open`, edges `proposed`; the old", "status stays as `earlierStatus`; prove", "again through `validate`"],
    size: 10.5,
  });
  f.box(36 + 2 * (ew + 16), 656, ew - 4, 84, {
    role: "neutral",
    title: "Either way",
    lines: ["attempts, lessons, nodes carry as memory,", "stamped and unverified; a problem's outcome,", "tasks and spend do not carry"],
    size: 10.5,
  });
  return f;
}
