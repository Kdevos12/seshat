import { Figure, ROLES } from "../svg.ts";

/** Two levels of checking: the fast check in a REPL, then certification in fresh, sandboxed processes. */
export function certification(): Figure {
  const f = new Figure(
    1000,
    640,
    "Certification: a fast check, then a kernel replay",
    "The fast check gives a prover exact feedback and makes a candidate; only a replay in a fresh, sandboxed process makes a proof.",
  );
  const L = ROLES.lean.stroke;

  // (a) The fast check.
  f.panel(24, 80, 952, 206, "(a) Fast check: `ProofValidator.validate`");
  const fileX = 36;
  const rows: [string, boolean][] = [
    ["prefix", false],
    ["auxiliary lemmas", true],
    ["header: statement", false],
    ["proof region", true],
    ["suffix", false],
  ];
  rows.forEach(([t, edit], i) => {
    f.box(fileX, 118 + i * 26, 164, 22, {
      role: edit ? "model" : "neutral",
      lines: [t],
      size: 10.5,
      radius: 4,
    });
  });
  f.text(fileX + 82, 262, "the prover edits two regions", { size: 10, color: "#5b6475", anchor: "middle" });
  const y = 118;
  const h = 132;
  const s1 = f.box(218, y, 142, h, {
    role: "control",
    title: "1 Rebuild",
    lines: ["the file from the fixed", "parts and the two", "regions; edits outside", "them are discarded"],
    size: 10.5,
  });
  const s2 = f.box(378, y, 142, h, {
    role: "control",
    title: "2 Token screen",
    lines: ["refuses `sorry`, `axiom`,", "`native_decide`, `#eval`,", "`run_cmd`, the meta level:", "a refused file never", "reaches Lean"],
    size: 10.5,
  });
  const s3 = f.box(538, y, 142, h, {
    role: "lean",
    status: "real",
    icon: "lean",
    title: "3 Kimina REPL",
    lines: ["the file, then", "`#print axioms` and", "`#check @T` with", "`pp.all`"],
    size: 10.5,
  });
  const s4 = f.box(698, y, 150, h, {
    role: "lean",
    status: "real",
    title: "4 Accepted when",
    lines: ["no error in the file;", "axioms within `propext`,", "`Classical.choice`,", "`Quot.sound`; type equal", "to the original's"],
    size: 10.5,
  });
  const comp = f.box(866, y, 98, h, {
    role: "lean",
    status: "real",
    strong: true,
    title: "computed",
    lines: ["a candidate,", "not a proof"],
    size: 10.5,
  });
  f.arrow([[fileX + 164, 184], s1.left(0.5)]);
  f.arrow([s1.right(), s2.left()]);
  f.arrow([s2.right(), s3.left()]);
  f.arrow([s3.right(), s4.left()]);
  f.arrow([s4.right(), comp.left()], { color: L });

  // (b) The certifier.
  f.panel(24, 300, 952, 270, "(b) Certification, called by the orchestrator on a candidate");
  const cand = f.box(36, 358, 150, 86, {
    role: "neutral",
    title: "Candidate",
    lines: ["the file that passed", "the fast check"],
    size: 10.5,
  });
  const ref = f.box(36, 458, 150, 86, {
    role: "neutral",
    title: "Reference",
    lines: ["the problem's file, or one", "rebuilt from the claim's", "journaled statement"],
    size: 10.5,
  });
  f.panel(214, 328, 488, 226, undefined, { role: "control", dashed: true });
  f.text(226, 346, "SANDBOX BEFORE EVERY `LAKE` CALL", { size: 10, bold: true, color: ROLES.control.ink });
  f.text(690, 346, "bubblewrap or Docker, per host profile", { size: 10, italic: true, color: "#5b6475", anchor: "end" });
  const c1 = f.box(230, 358, 146, 86, {
    role: "lean",
    status: "real",
    title: "Compile candidate",
    lines: ["fresh process, own dir;", "the proof's code runs", "here: `.olean` out"],
    size: 10.5,
  });
  const c2 = f.box(230, 458, 146, 86, {
    role: "lean",
    status: "real",
    title: "Compile reference",
    lines: ["fresh process, own dir,", "after the first has ended;", "`.olean` out"],
    size: 10.5,
  });
  const prog = f.box(410, 358, 280, 186, {
    role: "lean",
    status: "real",
    strong: true,
    icon: "lean",
    title: "`SeshatCertify`, a fresh process",
    lines: [
      "reads both `.olean` files as data;",
      "none of their code is loaded",
      "",
      "1 same imports; no unsafe, partial constant",
      "2 kernel replay of every constant",
      "3  target type compared as terms, with what it",
      "   rests on (a definition by value, no proofs)",
      "4  axioms collected by the program itself",
    ],
    size: 10.5,
  });
  f.arrow([cand.right(0.5), c1.left()]);
  f.arrow([ref.right(0.5), c2.left()]);
  f.arrow([c1.right(), [prog.x, c1.cy]]);
  f.arrow([c2.right(), [prog.x, c2.cy]]);
  const vx = 722;
  const vw = 242;
  const v1 = f.box(vx, 357, vw, 58, {
    role: "lean",
    status: "real",
    strong: true,
    title: "`certified`",
    lines: ["`proved`; `refuted` for a proof", "of the negation"],
    size: 10.5,
  });
  const v2 = f.box(vx, 422, vw, 58, {
    role: "control",
    status: "real",
    title: "`rejected`",
    lines: ["stays `computed`; the reasons", "go in the validation"],
    size: 10.5,
  });
  const v3 = f.box(vx, 487, vw, 58, {
    role: "neutral",
    status: "real",
    title: "no answer",
    lines: ["timeout, aborted, unavailable:", "stays `computed`, no verdict"],
    size: 10.5,
  });
  f.arrow([prog.right(0.15), v1.left(0.5)], { color: L });
  f.arrow([prog.right(0.5), v2.left(0.5)]);
  f.arrow([prog.right(0.85), v3.left(0.5)]);

  f.legend(24, 598, [
    { role: "neutral", label: "file" },
    { role: "model", label: "edited by the prover" },
    { role: "control", label: "harness code, no Lean" },
    { role: "lean", label: "Lean" },
  ]);
  f.statusLegend(560, 598, ["real"]);
  return f;
}
