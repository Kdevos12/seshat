import { CLI_FLAGS } from "./parameters.ts";

/**
 * The help of the command line (plan change UX8, documentation/quickstart.md, "Help"): a short page of the everyday commands, the usage
 * and flags of one command, and the whole usage on request. The flags come from `CLI_FLAGS` (`parameters.ts`), the usage lines from the
 * usage text itself, so neither can drift from what the parser reads.
 */

/** The commands a person uses every day, in the order of a first run. */
export const EVERYDAY_COMMANDS: ReadonlyArray<readonly [string, string]> = [
  ["doctor", "what this machine lacks (Lean, the Lean server, a model key, the sandboxing), and how to fix it"],
  ["solve STATEMENT|FILE", "work on a problem of your own, in words or in Lean, under a dollar allowance (default $2)"],
  ["ui", "the same in a page on this machine: state a problem, watch the cost, stop, read the result"],
  ["resume RUN_DIR", "continue a run that stopped or waits for you"],
  ["report RUN_DIR", "print a run's report and rewrite its RESULT.md"],
  ["view RUN_DIR", "one HTML page of a run"],
  ["campaign STATEMENT|FILE", "a run that continues alone for days, under an allowance and a pace"],
];

/** The page `harness`, `harness --help` and `harness help` print. */
export function shortHelp(): string {
  const width = Math.max(...EVERYDAY_COMMANDS.map(([c]) => c.length));
  return [
    "usage: pnpm harness COMMAND [ARGUMENTS] [FLAGS]",
    "",
    "Everyday commands:",
    ...EVERYDAY_COMMANDS.map(([c, what]) => `  ${c.padEnd(width)}  ${what}`),
    "",
    "A first run:",
    "  pnpm harness doctor",
    '  pnpm harness solve "Every even number above two is a sum of two primes." --max-usd 2',
    "",
    "harness COMMAND --help   the usage and flags of one command",
    "harness help all         every command and flag (measurement, libraries, packs, team answers, ...)",
    "Documentation: documentation/quickstart.md, then documentation/README.md.",
  ].join("\n");
}

/** The usage lines of one command, cut from the whole usage: its `  harness COMMAND` lines and the lines that continue them. */
export function usageOf(command: string, usage: string): string[] {
  const lines = usage.split("\n");
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "");
  const block = lines.slice(1, end === -1 ? undefined : end);
  const out: string[] = [];
  let taking = false;
  for (const line of block) {
    if (/^ {2}harness /.test(line)) taking = line.startsWith(`  harness ${command} `) || line === `  harness ${command}`;
    if (taking) out.push(line);
  }
  return out;
}

/** Which flags of solve a newcomer needs first, and which say what leaves the machine. The rest are advanced. */
const SOLVE_GROUPS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["Basic", ["max-usd", "model", "out", "yes", "as", "lean", "prose", "turn-usd", "defaults", "quiet", "settings"]],
  ["What may leave this machine", ["lit", "private", "intake", "no-intake", "intake-usd", "lean-search", "no-lean-search"]],
];

/** The help of one command, or undefined when the command has no usage line. */
export function commandHelp(command: string, usage: string): string | undefined {
  const lines = usageOf(command, usage);
  if (lines.length === 0) return undefined;
  const flags = CLI_FLAGS.filter((f) => f.commands.some((c) => c === command || c.startsWith(`${command} `)));
  const row = (f: (typeof CLI_FLAGS)[number]) => `  --${f.flag.padEnd(22)} ${f.help}`;
  const sections: string[] = [];
  if (command === "solve" || command === "campaign") {
    const placed = new Set<string>();
    for (const [title, names] of SOLVE_GROUPS) {
      const here = names.map((n) => flags.find((f) => f.flag === n)).filter((f): f is (typeof CLI_FLAGS)[number] => f !== undefined);
      for (const f of here) placed.add(f.flag);
      if (here.length > 0) sections.push(`${title}:`, ...here.map(row), "");
    }
    const rest = flags.filter((f) => !placed.has(f.flag));
    if (rest.length > 0) sections.push("Advanced:", ...rest.map(row), "");
  } else if (flags.length > 0) {
    sections.push("Flags:", ...flags.map(row), "");
  }
  return ["usage:", ...lines, "", ...sections, "Every command and flag: harness help all. The settings a run takes: documentation/parameters.md."].join("\n");
}
