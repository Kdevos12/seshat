/**
 * The Lean server's memory (plan change CA4, documentation/lean.md, "Memory of the Lean server"): the Kimina settings that fit a machine,
 * and what `harness doctor` says when the server has grown past a threshold. Heuristics, not measurements: nothing here has run against a
 * real Kimina server.
 */

export interface KiminaSettings {
  /** The REPLs the server keeps at once. */
  MAX_REPLS: number;
  /** The checks one REPL serves before the server recycles it (Kimina's default is never, so a REPL grows for as long as the server runs). */
  MAX_REPL_USES: number;
  /** The memory one REPL may use before the server restarts it, as the server writes it (`6G`). */
  MAX_REPL_MEM: string;
}

/** What one REPL with Mathlib loaded takes, in megabytes, as a working figure. */
const REPL_MB = 4096;
/** The share of the machine's memory the Lean server may take; the rest is for the system, the harness and the certifier. */
const SERVER_SHARE = 0.6;
const MAX_REPLS_CAP = 32;

/** Settings that fit a machine with this much memory in all, in megabytes. At least one REPL, whatever the machine. */
export function kiminaSettingsFor(totalMb: number): KiminaSettings {
  const usable = Math.max(0, totalMb) * SERVER_SHARE;
  const repls = Math.max(1, Math.min(MAX_REPLS_CAP, Math.floor(usable / REPL_MB)));
  const perReplGb = Math.max(2, Math.floor(usable / repls / 1024));
  // A small machine recycles its REPLs sooner: a REPL that leaks costs it more.
  return { MAX_REPLS: repls, MAX_REPL_USES: totalMb < 32 * 1024 ? 50 : 100, MAX_REPL_MEM: `${perReplGb}G` };
}

/**
 * The resident memory, in megabytes, of the processes that look like a Kimina server and its REPLs, from the output of
 * `ps -eo rss=,args=` (RSS in kilobytes, then the command line). Undefined when no such process is listed: no number, no warning.
 */
export function leanServerMemoryFromPs(output: string): number | undefined {
  let kb = 0;
  let found = false;
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const args = match[2] ?? "";
    if (!/kimina|(^|[\s/])repl(\s|$)/i.test(args)) continue;
    kb += Number(match[1]);
    found = true;
  }
  return found ? Math.round(kb / 1024) : undefined;
}

const gb = (mb: number): string => `${(mb / 1024).toFixed(mb >= 10 * 1024 ? 0 : 1)} GB`;

/** The check `harness doctor` shows: the settings that fit this machine, and a warning when the server's memory passes `warnMb`. */
export function leanMemoryCheck(o: { totalMb: number; serverMb: number | undefined; warnMb: number }): { status: "ok" | "warn"; detail: string; fix?: string } {
  const s = kiminaSettingsFor(o.totalMb);
  const settings = `MAX_REPLS=${s.MAX_REPLS}, MAX_REPL_USES=${s.MAX_REPL_USES}, MAX_REPL_MEM=${s.MAX_REPL_MEM}`;
  const advice = `This machine has ${gb(o.totalMb)}. Suggested settings of the Kimina server: ${settings}. (The server never recycles a REPL unless MAX_REPL_USES is set, so its memory only grows.)`;
  if (o.serverMb !== undefined && o.serverMb > o.warnMb) {
    return {
      status: "warn",
      detail: `The Lean server takes ${gb(o.serverMb)} of memory, more than the ${gb(o.warnMb)} this host allows it (leanServerMemoryWarnMb). ${advice}`,
      fix: `Restart the server with those settings; a run that fills the machine's memory ends in checks that time out.`,
    };
  }
  return { status: "ok", detail: `${advice}${o.serverMb === undefined ? "" : ` The Lean server takes ${gb(o.serverMb)} now.`}` };
}
