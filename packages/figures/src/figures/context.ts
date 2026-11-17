import { Figure, ROLES, MUTED, textLine, type Role } from "../svg.ts";

/** Line M4: a packet under a token budget in place of the growing history. */
export function context(): Figure {
  const f = new Figure(
    1000,
    662,
    "Context: a packet under a budget, not the whole history",
    "Line M4 sends each request a frozen prefix and a freshly compiled tail, with citable ids and two tools to look further.",
  );

  const seg = (x: number, y: number, w: number, h: number, role: Role, label?: string): void => {
    const st = ROLES[role];
    f.raw(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${st.fill}" stroke="${st.stroke}" stroke-width="1"/>`, "mid");
    if (label) f.raw(textLine(x + w / 2, y + h / 2 + 3.8, label, { size: 10.5, anchor: "middle", color: st.ink, bold: true }), "front");
  };

  // (a) Per request.
  f.panel(24, 76, 952, 214, "(a) What each request carries");
  f.text(36, 114, "**Raw history**: each request resends the conversation, so it grows", { size: 11 });
  f.text(504, 114, "**Packet**: the prefix stays byte for byte, the tail is new", { size: 11 });
  for (let n = 1; n <= 5; n++) {
    const y = 128 + (n - 1) * 26;
    f.text(36, y + 12, `request ${n}`, { size: 10, color: MUTED });
    f.text(504, y + 12, `request ${n}`, { size: 10, color: MUTED });
    let x = 100;
    seg(x, y, 50, 16, "neutral");
    x += 50;
    seg(x, y, 40, 16, "neutral");
    x += 40;
    for (let k = 0; k < (n - 1) * 2; k++) {
      seg(x, y, 30, 16, k % 2 === 0 ? "model" : "lean");
      x += 30;
    }
    let px = 568;
    seg(px, y, 50, 16, "neutral");
    px += 50;
    seg(px, y, 200, 16, "control");
    px += 200;
    seg(px, y, [40, 62, 50, 72, 56][n - 1]!, 16, "cpu");
  }
  // Budget mark on the packet side.
  f.raw(`<line x1="${568 + 50 + 200 + 80}" x2="${568 + 50 + 200 + 80}" y1="124" y2="262" stroke="#4a5567" stroke-width="1.2" stroke-dasharray="4 3"/>`, "front");
  f.text(568 + 50 + 200 + 86, 138, ["token", "budget"], { size: 10, color: MUTED });
  f.legend(36, 276, [
    { role: "neutral", label: "system, tools, opening message" },
    { role: "model", label: "a model turn" },
    { role: "lean", label: "a Lean or tool result" },
    { role: "control", label: "prefix" },
    { role: "cpu", label: "tail" },
  ]);

  // (b) One packet, to the scale of the default budget.
  f.panel(24, 302, 952, 168, "(b) One packet at the default budget: `tokens` 6000, `prefixShare` 0.8");
  const x0 = 36;
  const bw = 928;
  const pw = bw * 0.8;
  const by = 350;
  const bh = 36;
  f.text(x0, 340, "**Prefix**, 4800 tokens: frozen at the first request, sections in a fixed order", { size: 10.5 });
  f.text(x0 + pw + 8, 340, "**Tail**, 1200 tokens", { size: 10.5 });
  const secs: [string, string[]][] = [
    ["Goal", ["the claim's id and", "statement, as Lean;", "always kept"]],
    ["Useful facts", ["PageRank and symbol", "similarity; badges;", "ids `C` and `E`"]],
    ["Candidate premises", ["local, library, other", "packages, Mathlib;", "ids `L`"]],
    ["Already tried", ["M1's lines, at most", "`maxTried`"]],
    ["Active lessons", ["M5's, as the draw", "left them; ids `A`"]],
    ["Other lines' notes", ["briefings, screened", "and capped"]],
  ];
  const sw = pw / secs.length;
  secs.forEach(([name, desc], i) => {
    seg(x0 + i * sw, by, sw, bh, "control", name);
    f.text(x0 + i * sw + 5, by + bh + 16, desc, { size: 10, color: "#2b3340" });
  });
  seg(x0 + pw, by, bw - pw, bh, "cpu", "Tail");
  f.text(x0 + pw + 5, by + bh + 16, ["where the session stands,", "file regions, holes,", "last raw Lean answer,", "tool answers, `newSince`"], { size: 10, color: "#2b3340" });
  f.text(x0, 456, "every shown item has a citable id; an item the budget cut has none. The sections are not drawn to scale: their sizes vary.", { size: 10, color: MUTED });

  // (c) Premises and tools.
  f.panel(24, 482, 952, 136, "(c) Where premises come from, and the tools");
  const cy = 508;
  const ch = 98;
  const sel = f.box(36, cy, 136, ch, {
    role: "cpu",
    status: "sim",
    title: "Selectors",
    lines: ["MePo, SInE,", "online k-NN over", "the run's proofs,", "pattern seeds"],
    size: 10,
  });
  const mix = f.box(202, cy, 120, ch, { role: "cpu", status: "sim", title: "Convex mix", lines: ["of the channels,", "no training"], size: 10 });
  const acc = f.box(352, cy, 150, ch, {
    role: "cpu",
    status: "sim",
    title: "Accessibility",
    lines: ["a premise the file's", "header cannot see is", "not offered, or marked", "`(needs: import M)`"],
    size: 10,
  });
  const cand = f.box(532, cy, 120, ch, { role: "control", status: "sim", title: "Candidate premises", lines: ["a section of the", "prefix, ids `L`"], size: 9.5 });
  f.arrow([sel.right(), mix.left()]);
  f.arrow([mix.right(), acc.left()]);
  f.arrow([acc.right(), cand.left()]);
  const t1 = f.box(688, cy, 276, 44, { role: "neutral", status: "sim", title: "`expand(id)`", lines: ["one item in full, with its neighbours"], size: 10 });
  const t2 = f.box(688, cy + 54, 276, 44, { role: "neutral", status: "sim", title: "`graph_query`", lines: ["a pattern, anchors, or a typed query"], size: 10 });
  void t1;
  void t2;
  f.text(826, 502, "journaled as tool runs of `line:M4`; answers go in the tail", { size: 9.5, color: MUTED, anchor: "middle" });

  f.statusLegend(24, 642, ["real", "sim"]);
  return f;
}
