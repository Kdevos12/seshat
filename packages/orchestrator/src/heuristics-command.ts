import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readEvents } from "@seshat/core";
import { type BankCard, bankOf, bankProposals, checkBank, heuristicReport, heuristicStats, renderCardLine, type CardSession } from "@seshat/heuristics";
import { loadInstalledPacks } from "@seshat/registry";
import { packsDirectory } from "./implementations.ts";
import { RunSetupError } from "./setup-error.ts";

/**
 * `harness heuristics list|stats|mine` (documentation/heuristics.md): the bank a run would draw from, built in and from
 * the installed packs; the bank's statistics of a run; and the proposals the statistics of finished runs suggest. All
 * three read; none calls a model, and none writes a journal or a card.
 */
export interface HeuristicsIo {
  /** The pack directory. Default: `SESHAT_PACKS_DIR`, then `packs/` of this repository. */
  packsDir?: string | undefined;
  /** `mine`: where to write the proposals as JSON, for a person to read. */
  outFile?: string | undefined;
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

function eventsOf(dir: string) {
  const journal = join(resolve(dir), "journal.jsonl");
  if (!existsSync(journal)) throw new RunSetupError(`${dir} is not a run directory: it has no journal.jsonl`);
  return readEvents(journal);
}

/** The sessions with a draw of every run, from their journals. */
function sessionsOf(dirs: readonly string[]): CardSession[] {
  const sessions: CardSession[] = [];
  for (const dir of dirs) {
    const byId = new Map<string, CardSession>();
    for (const event of eventsOf(dir)) {
      if (event.type === "attempt.started" && typeof event.data.settings?.heuristic === "string") {
        byId.set(event.data.attemptId, { attemptId: event.data.attemptId, settings: event.data.settings });
      } else if (event.type === "attempt.finished") {
        const s = byId.get(event.data.attemptId);
        if (s !== undefined) Object.assign(s, { outcome: event.data.outcome, strategy: event.data.strategy });
      }
    }
    sessions.push(...byId.values());
  }
  return sessions;
}

export function heuristicsCommand(action: "list" | "stats" | "mine", dirs: readonly string[], o: HeuristicsIo): number {
  const bank = installedBank(o.packsDir);
  if (action === "list") {
    for (const card of bank) {
      const when = card.when !== undefined || card.whenNot !== undefined ? "  (conditional)" : "";
      o.out(`${card.id}  [${card.family}, ${card.level}, ${card.origin}]${when}  ${card.ask}`);
    }
    const check = checkBank(bank);
    for (const overlap of check.overlaps) o.out(`overlap: ${overlap.a} and ${overlap.b} (family ${overlap.family}): ${overlap.reason}`);
    const families = new Set(bank.map((c) => c.family)).size;
    o.out(`${bank.length} card(s), ${families} famil${families === 1 ? "y" : "ies"}; the fleet draws them with the option heuristics on.`);
    return 0;
  }
  if (dirs.length === 0) throw new RunSetupError(`heuristics ${action} needs a run directory`);
  if (action === "stats") {
    if (dirs.length > 1) throw new RunSetupError("heuristics stats reads one run; heuristics mine reads several");
    const stats = heuristicReport(eventsOf(dirs[0] as string), bank);
    if (stats === undefined) {
      o.out("No session of this run had a draw of the bank: the option heuristics was off.");
      return 0;
    }
    o.out(`${stats.sessions} session(s) with a draw and a verdict. Control (no card): ${stats.control.valid} of ${stats.control.sessions} valid. No card applied: ${stats.noneApplicable}.`);
    o.out("By family:");
    for (const line of stats.families) o.out(`  ${renderCardLine(line)}`);
    o.out("By card:");
    for (const line of stats.cards) o.out(`  ${renderCardLine(line)}`);
    if (stats.unexplained.length > 0) {
      o.out("Accepted proofs that went another way than their card:");
      for (const u of stats.unexplained) o.out(`  ${u.attemptId ?? "?"}: ${u.card} (${u.expected}) in ${u.bucket}, proved by ${u.strategy}`);
    }
    o.out("No model. The effect is PE2's: P(effect < 0) from the sessions with the card against the control sessions of its buckets that could have had it. Every session counts once: unlike the draw, no discount, probation or weight for another model.");
    return 0;
  }
  const stats = heuristicStats(sessionsOf(dirs), bank);
  const proposals = bankProposals(stats);
  o.out(`${stats.sessions} session(s) with a draw and a verdict in ${dirs.length} run(s); control ${stats.control.valid} of ${stats.control.sessions} valid.`);
  if (proposals.length === 0) o.out("No proposal: no card is deactivated or without effect on this evidence.");
  for (const p of proposals) o.out(`${p.kind} ${p.card}${p.bucket !== undefined ? ` in ${p.bucket}` : ""}: ${p.reason} (difference ${p.difference}, P(effect < 0) ${p.pNegative}, ${p.sessions} against ${p.controlSessions})`);
  for (const u of stats.unexplained) o.out(`unexplained success ${u.attemptId ?? "?"}: ${u.card} (${u.expected}) in ${u.bucket}, proved by ${u.strategy}`);
  if (o.outFile !== undefined) {
    writeFileSync(o.outFile, `${JSON.stringify({ runs: dirs.map((d) => resolve(d)), sessions: stats.sessions, control: stats.control, proposals, unexplained: stats.unexplained }, null, 2)}\n`);
    o.out(`proposals written to ${o.outFile}`);
  }
  o.out("Every session counts once here (no discount, probation or weight for another model, unlike the draw).");
  o.out("A proposal changes nothing: a person edits the card (a built-in card through a reviewed commit, a pack's through a new version of the pack).");
  return 0;
}
