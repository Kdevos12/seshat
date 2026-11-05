import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { readEvents } from "@seshat/core";
import { type BankCard, bankOf, checkBank, heuristicReport, renderCardLine } from "@seshat/heuristics";
import { loadInstalledPacks } from "@seshat/registry";
import { packsDirectory } from "./implementations.ts";
import { RunSetupError } from "./setup-error.ts";

/**
 * `harness heuristics list|stats RUN_DIR` (documentation/heuristics.md): the bank a run would draw from, built in and
 * from the installed packs, and the bank's statistics of a run. Both read; neither calls a model or writes anything.
 */
export interface HeuristicsIo {
  /** The pack directory. Default: `SESHAT_PACKS_DIR`, then `packs/` of this repository. */
  packsDir?: string | undefined;
  out: (line: string) => void;
}

/** The bank of the installed packs; a pack that does not load is a setup error, as it would be for a run. */
function installedBank(packsDir: string | undefined): BankCard[] {
  try {
    return bankOf(loadInstalledPacks(packsDirectory(packsDir)).map((p) => ({ name: p.manifest.name, heuristics: p.heuristics })));
  } catch (error) {
    if (error instanceof Error) throw new RunSetupError(error.message, { cause: error });
    throw error;
  }
}

export function heuristicsCommand(action: "list" | "stats", dir: string | undefined, o: HeuristicsIo): number {
  const bank = installedBank(o.packsDir);
  if (action === "list") {
    for (const card of bank) {
      const when = card.when !== undefined || card.whenNot !== undefined ? "  (conditional)" : "";
      o.out(`${card.id}  [${card.family}, ${card.level}, ${card.origin}]${when}  ${card.ask}`);
    }
    const check = checkBank(bank);
    for (const overlap of check.overlaps) o.out(`overlap: ${overlap.a} and ${overlap.b} (family ${overlap.family}): ${overlap.reason}`);
    o.out(`${bank.length} card(s), ${new Set(bank.map((c) => c.family)).size} famil${new Set(bank.map((c) => c.family)).size === 1 ? "y" : "ies"}; the fleet draws them with the option heuristics on.`);
    return 0;
  }
  if (dir === undefined) throw new RunSetupError("heuristics stats needs a run directory");
  const journal = join(resolve(dir), "journal.jsonl");
  if (!existsSync(journal)) throw new RunSetupError(`${dir} is not a run directory: it has no journal.jsonl`);
  const stats = heuristicReport(readEvents(journal), bank);
  if (stats === undefined) {
    o.out("No session of this run had a draw of the bank: the option heuristics was off.");
    return 0;
  }
  o.out(`${stats.sessions} finished session(s) with a draw. Control (no card): ${stats.control.valid} of ${stats.control.sessions} valid. No card applied: ${stats.noneApplicable}.`);
  o.out("By family:");
  for (const line of stats.families) o.out(`  ${renderCardLine(line)}`);
  o.out("By card:");
  for (const line of stats.cards) o.out(`  ${renderCardLine(line)}`);
  o.out("Counts only, no model and no test of significance. Each line is set against the control of its own buckets.");
  return 0;
}
