import { Figure, ROLES, MUTED as MUT } from "../svg.ts";

/** Trust: the claim status state machine and the only causes of each transition. */
export function trust(): Figure {
  const f = new Figure(
    1000,
    610,
    "Trust: only Lean changes a claim's status",
    "A claim is raised by a Lean check or by the certifier's kernel replay, and lowered only by `retractClaim`; everything else is evidence.",
  );
  const L = ROLES.lean.stroke;
  const C = ROLES.control.stroke;

  // (a) State machine.
  f.text(24, 84, "(a) Claim statuses and the transitions that matter", { size: 11.5, bold: true, color: ROLES.control.ink });
  const pre = f.panel(24, 96, 372, 196, "Before certification");
  const open = f.box(42, 132, 112, 64, { role: "neutral", title: "open", lines: ["a conjecture"], strong: false });
  const comp = f.box(250, 132, 128, 64, { role: "lean", status: "real", title: "computed", lines: ["a candidate"] });
  const proved = f.box(500, 108, 156, 64, { role: "lean", status: "real", strong: true, title: "proved", lines: ["a certified proof"] });
  const refuted = f.box(500, 214, 156, 64, { role: "lean", status: "real", strong: true, title: "refuted", lines: ["a certified negation"] });
  const retr = f.box(790, 160, 186, 64, { role: "neutral", title: "retracted", lines: ["withdrawn; a proof is never", "downgraded, only retracted"] });
  const inf = f.box(500, 330, 156, 64, { role: "neutral", title: "proved_informal", lines: ["an informal proof,", "kept for later"] });

  // 1: fast check, open -> computed.
  f.arrow([open.right(), comp.left()], { color: L, label: ["fast check", "passes"], labelAt: [202, 144] });
  f.badge(202, 114, "1", L);
  // retract back: computed -> open.
  f.arrow([comp.bottom(0.5), [comp.cx, 250], [open.cx, 250], open.bottom(0.5)], { color: C, dashed: true });
  f.text(open.cx + 60, 244, "`retractClaim`", { size: 10.5, color: MUT, anchor: "middle" });
  f.badge(open.cx + 60, 266, "3", C);

  // 2: kernel replay, open or computed -> proved / refuted.
  f.arrow([[pre.r, 140], [proved.x, 140]], { color: L });
  f.arrow([[pre.r, 246], refuted.left()], { color: L });
  f.text(448, 108, ["`kernel_replay`", "certified"], { size: 10.5, color: MUT, anchor: "middle" });
  f.text(448, 214, ["certified proof", "of the negation"], { size: 10.5, color: MUT, anchor: "middle" });
  f.badge(430, 158, "2", L);
  f.badge(430, 264, "2", L);

  // 3: retractClaim, proved / refuted / informal -> retracted.
  f.arrow([proved.right(), [722, proved.cy], [722, 176], [retr.x, 176]], { color: C, dashed: true });
  f.arrow([refuted.right(), [722, refuted.cy], [722, 208], [retr.x, 208]], { color: C, dashed: true });
  f.arrow([inf.right(), [883, inf.cy], [883, retr.b]], { color: C, dashed: true });
  f.badge(740, 192, "3", C);
  f.text(894, 290, "`retractClaim`", { size: 10.5, color: MUT, anchor: "start" });

  // proved_informal: allowed, kept for later.
  f.arrow([[pre.cx, pre.b], [pre.cx, inf.cy], inf.left()], { color: "#8b94a5", dashed: true, label: "allowed", labelAt: [pre.cx + 38, inf.cy - 10] });
  f.text(inf.r + 16, inf.cy + 28, "later `proved` or `refuted` by `kernel_replay`", { size: 10.5, color: MUT, anchor: "start" });

  // (b) Who may cause what.
  f.text(24, 428, "(b) Who can cause a transition", { size: 11.5, bold: true, color: ROLES.control.ink });
  const y = 440;
  const h = 96;
  const w = 226;
  const gap = 16;
  const b1 = f.box(24, y, w, h, {
    role: "lean",
    status: "real",
    icon: "lean",
    title: "Fast check",
    lines: ["`validate` + a Lean REPL pass:", "`open` to `computed`.", "Only a Lean check makes", "`computed`."],
  });
  const b2 = f.box(24 + (w + gap), y, w, h, {
    role: "lean",
    status: "real",
    strong: true,
    icon: "lean",
    title: "Certifier",
    lines: ["`kernel_replay` certified:", "`proved`, or `refuted` for a", "proof of the negation.", "Rejected or no answer: no change."],
  });
  const b3 = f.box(24 + 2 * (w + gap), y, w, h, {
    role: "control",
    status: "real",
    title: "`retractClaim`",
    lines: ["the only way down, with a reason:", "`computed` to `open`; `proved`,", "`refuted`, `proved_informal`", "to `retracted`. Line M2 calls it."],
  });
  const b4 = f.box(24 + 3 * (w + gap), y, w - 4, h, {
    role: "neutral",
    title: "Evidence only, no status",
    lines: ["tool output (SMT, ATP, algebra,", "fingerprints), models, `decide`,", "people (hints, signatures),", "literature: nodes and edges."],
  });
  f.badge(b1.x + 14, y + 14, "1", L);
  f.badge(b2.x + 14, y + 14, "2", L);
  f.badge(b3.x + 14, y + 14, "3", C);

  const j = f.box(24, 552, 952, 34, {
    role: "truth",
    icon: "journal",
    status: "real",
    title: "The journal refuses any other change",
    align: "start",
  });
  f.text(j.r - 12, j.cy + 4, "`computed` needs a valid validation; `proved`/`refuted` a certified `kernel_replay` one", {
    size: 10.5,
    color: ROLES.truth.ink,
    anchor: "end",
  });
  void b4;
  return f;
}
