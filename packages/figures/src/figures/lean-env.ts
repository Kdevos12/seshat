import { Figure, MUTED, ROLES } from "../svg.ts";

/** Lean environments as data, and the gate in front of anything a coding agent adds to them. */
export function leanEnv(): Figure {
  const f = new Figure(
    1000,
    560,
    "Lean environments as data, and the gate in front of new Lean",
    "An environment is a file the resolver checks before anything is built; what a coding agent writes reaches it only through Seshat's gate.",
  );

  // (a) The environment pipeline.
  const a = f.panel(24, 76, 952, 196, "(a) An environment, from its file to every tool run", { role: "lean" });
  const y = a.y + 34;
  const h = 140;
  const file = f.box(40, y, 200, h, {
    role: "neutral",
    status: "sim",
    title: "`lean/env/extended.toml`",
    lines: ["toolchain `v4.27.0`", "base: formal-conjectures", "at `bench-v1-lean4.27.0`", "packages: Duper, LeanAPAP,", "PFR; local: SeshatMeta"],
    size: 10.5,
  });
  const resolver = f.box(270, y, 220, h, {
    role: "control",
    status: "sim",
    title: "Resolver",
    lines: [
      "reads each package's `lean-toolchain`",
      "and `lake-manifest.json`;",
      "**refuses**, naming every problem:",
      "two toolchains; a shared dependency",
      "at two commits; a revision that",
      "another package does not want",
    ],
    size: 10,
  });
  const lock = f.box(520, y, 200, h, {
    role: "truth",
    status: "sim",
    title: "Lock and hash",
    lines: ["SHA-256 of the canonical", "JSON of the toolchain, the", "packages and every", "dependency's commit; same", "hash: same Lean, same Mathlib"],
    size: 10.5,
  });
  const build = f.box(750, y, 210, h, {
    role: "lean",
    status: "sim",
    title: "Build and use",
    lines: ["`lake exe cache get`, `lake build`;", "the project the Lean tools", "run in; the hash is in the", "version of every Lean tool", "run, so results never mix"],
    size: 10.5,
  });
  f.arrow([file.right(), resolver.left()]);
  f.arrow([resolver.right(), lock.left()]);
  f.arrow([lock.right(), build.left()]);

  // (b) The LibraryBuilder and its gate.
  const b = f.panel(24, 288, 952, 226, "(b) The LibraryBuilder (off by default): a coding agent behind Seshat's gate", { role: "control" });
  const agent = f.box(40, b.y + 40, 170, 120, {
    role: "model",
    icon: "model",
    status: "sim",
    title: "Coding agent",
    lines: ["in a sandboxed clone,", "with only the variables", "the config names; adds", "files under", "`lean/SeshatLib/<Domain>/`"],
    size: 10.5,
  });
  const rules: [string, string[]][] = [
    ["diff", ["only new, regular", "files, one directory"]],
    ["content", ["the validator's", "token screen"]],
    ["spec", ["items and test", "lemmas exist"]],
    ["build", ["fresh checkout,", "`lake build`"]],
    ["build_output", ["no `sorry` in", "the build output"]],
    ["certify", ["every new theorem", "kernel-replayed"]],
  ];
  const gx = 250;
  const gw = 112;
  const gy = b.y + 40;
  f.text(gx, gy - 8, "Seshat's gate: in order; the first rule that fails ends the build; each check is journaled", {
    size: 10.5,
    color: MUTED,
  });
  rules.forEach(([name, what], i) => {
    const bx = gx + i * (gw + 8);
    f.box(bx, gy, gw, 56, { role: i === 5 ? "lean" : "cpu", status: "sim", title: `\`${name}\``, lines: what, size: 9.5 });
    if (i > 0) f.arrow([[bx - 8, gy + 28], [bx, gy + 28]]);
    f.badge(bx + 2, gy + 2, String(i + 1), ROLES[i === 5 ? "lean" : "cpu"].stroke, 7);
  });
  f.arrow([agent.right(0.3), [gx, gy + 28]], { label: "files" , labelAt: [230, gy + 20] });
  const accepted = f.box(gx, b.y + 124, 350, 76, {
    role: "truth",
    status: "sim",
    title: "Accepted: `adoptBuild`, between runs",
    lines: ["files land all or none; the local package's hash", "changes, so the next resolve gives a new environment", "hash; a run that is going keeps its own"],
    size: 10,
  });
  const defs = f.box(gx + 370, b.y + 124, 342, 76, {
    role: "human",
    icon: "human",
    status: "sim",
    title: "New definitions are `unreviewed`",
    lines: ["a proof may use one (the kernel checks it); a claim", "statement may not, until a person signs it faithful", "(`harness library review NAME --as PERSON`)"],
    size: 10,
  });
  const last = gx + 5 * (gw + 8);
  f.arrow([[last + gw / 2, gy + 56], [last + gw / 2, b.y + 110], [accepted.cx, b.y + 110], [accepted.cx, accepted.y]]);
  f.arrow([[last + gw / 2, b.y + 110], [defs.cx, b.y + 110], [defs.cx, defs.y]], { heads: "end" });

  f.statusLegend(24, 538, ["sim"]);
  return f;
}

