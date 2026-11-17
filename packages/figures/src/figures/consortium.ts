import { Figure, MUTED, RULE } from "../svg.ts";

/** Consortium mode: turns that stop, an account built from the journal, answers that change no status. */
export function consortium(): Figure {
  const f = new Figure(
    1000,
    572,
    "Consortium mode: the run stops, says where it stands, and waits",
    "A turn ends at a limit or a breakpoint; the account is built from the journal with no model, and the team's answers steer the next turn without changing a status.",
  );

  // Lane separators and labels.
  const lanes: [string, number][] = [["THE RUN", 106], ["THE ACCOUNT", 230], ["THE TEAM", 338], ["THE JOURNAL", 458]];
  f.raw(
    [214, 328, 446].map((y) => `<line x1="24" y1="${y + 8}" x2="976" y2="${y + 8}" stroke="${RULE}" stroke-width="1"/>`).join(""),
    "back",
  );
  for (const [t, y] of lanes) f.text(36, y + 18, t, { size: 10.5, bold: true, color: MUTED });

  const ty = 106;
  const th = 108;
  const tw = 126;
  const gw = 190;
  const turnX = [140, 488, 836];
  const gapX = [282, 630];

  const turns = turnX.map((x, i) =>
    f.box(x, ty, tw, th, {
      role: "model",
      status: "sim",
      icon: "model",
      title: `Turn ${i + 1}`,
      lines: i < 2 ? ["sessions work; after", "the limit no new call", "starts, one in flight", "finishes"] : ["sessions work", "until the run", "finishes"],
      size: 10.5,
    }),
  );
  const ends = gapX.map((x) =>
    f.box(x, ty, gw, th, {
      role: "control",
      status: "sim",
      icon: "flag",
      title: "The turn ends",
      lines: ["a limit: `--turn-usd`,", "`--turn-tokens` or", "`--turn-minutes`;", "or a breakpoint: `impasse`,", "`settled`, `literature`...;", "then it waits, spending nothing"],
      size: 10.5,
    }),
  );
  const accounts = gapX.map((x, i) =>
    f.box(x, 230, gw, 92, {
      role: "truth",
      status: "sim",
      icon: "doc",
      title: `Account of turn ${i + 1}`,
      lines: ["`turns/" + (i + 1) + "/report.md`, built from the", "journal by code, no model: why it", "ended, what it spent, each problem,", "what the team is asked"],
      size: 10.5,
    }),
  );
  const answers = gapX.map((x) =>
    f.box(x, 338, gw, 100, {
      role: "human",
      icon: "human",
      title: "Answers as `human:NAME`",
      lines: ["`harness hint` on a claim", "`harness sign` an edge", "`harness steer`: focus, drop,", "forbid, the next limit"],
      size: 10.5,
    }),
  );
  const resumes = [turnX[1]!, turnX[2]!].map((x, i) =>
    f.box(x, 352, tw, 72, {
      role: "control",
      status: "sim",
      icon: "loop",
      title: "Resume",
      lines: ["`harness resume`", `turn ${i + 2} begins`],
      size: 10.5,
    }),
  );
  const band = f.box(140, 458, 824, 56, {
    role: "truth",
    icon: "journal",
    title: "The journal",
    lines: ["a hint, a signature and a steer are events of `human:NAME`: they change what sessions are told and the order of work,", "never a claim's status; only the certifier's kernel replay makes `proved` or `refuted`"],
    size: 10.5,
  });

  for (let i = 0; i < 2; i++) {
    f.arrow([turns[i]!.right(0.5), ends[i]!.left(0.5)]);
    f.arrow([ends[i]!.bottom(), accounts[i]!.top()]);
    f.arrow([accounts[i]!.bottom(), answers[i]!.top()]);
    f.arrow([answers[i]!.right(), resumes[i]!.left()]);
    f.arrow([resumes[i]!.top(), turns[i + 1]!.bottom()]);
    f.arrow([[answers[i]!.cx, answers[i]!.b], [answers[i]!.cx, band.y]], { color: "#a87414" });
  }
  f.statusLegend(24, 546, ["sim"]);
  f.legend(330, 546, [
    { role: "model", label: "a model" },
    { role: "control", label: "limits, breakpoints" },
    { role: "truth", label: "journal, account" },
    { role: "human", label: "the team" },
  ]);
  return f;
}
