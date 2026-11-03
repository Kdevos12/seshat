import { join, resolve } from "node:path";
import { BlobStore, type Json, newId } from "@seshat/core";
import { allLessons, DECISION_KIND, decisionData, stagedLessons } from "@seshat/lessons";
import { MemoryStore } from "@seshat/memory";
import { RunSetupError } from "./setup-error.ts";
import { humanActor, openForAnswers, personName } from "./team.ts";

/**
 * `harness lessons pending|approve|reject RUN_DIR [ID]` (documentation/lessons.md, "Staged promotion"): with `--human`,
 * a lesson that would apply to every problem waits here for the team. The answer is a `lesson_decision` node under the
 * person's name; no claim's status changes, and a lesson the team rejects stays in the journal, no longer shown.
 */
export interface LessonsOptions {
  as?: string | undefined;
  note?: string | undefined;
  out: (line: string) => void;
}

const line = (l: { nodeId: string; text: string; type: string; claims: string[]; support: string[] }): string =>
  `${l.nodeId}  [${l.type}] ${l.text}  (${l.claims.length} claim(s), ${l.support.length} attempt(s))`;

export function lessonsCommand(action: "pending" | "approve" | "reject", dir: string, o: LessonsOptions & { id?: string | undefined }): number {
  const journal = openForAnswers(resolve(dir));
  try {
    const memory = new MemoryStore({ journal, blobs: new BlobStore(join(resolve(dir), "blobs")) });
    const staged = stagedLessons(memory);
    if (action === "pending") {
      if (staged.length === 0) o.out("No lesson waits for the team.");
      for (const l of staged) o.out(line(l));
      if (staged.length > 0) o.out(`Answer with: harness lessons approve|reject ${dir} ID (several people may answer before one resumes the run).`);
      return 0;
    }
    if (o.id === undefined) throw new RunSetupError(`lessons ${action} needs the id of a lesson: harness lessons pending ${dir} lists them`);
    const lesson = allLessons(memory).find((l) => l.nodeId === o.id);
    if (lesson === undefined) throw new RunSetupError(`no lesson ${o.id} in this run`);
    if (lesson.state !== "pending") throw new RunSetupError(`lesson ${o.id} is ${lesson.state}: only a lesson that waits for the team can be approved or rejected`);
    const by = personName(o.as);
    const data = decisionData({ lessonId: lesson.nodeId, decision: action, by, ...(o.note !== undefined ? { note: o.note } : {}) });
    journal.emit("node.recorded", { nodeId: newId("nod"), kind: DECISION_KIND, data: data as unknown as Json }, humanActor(by));
    o.out(
      action === "approve"
        ? `${by}: lesson ${lesson.nodeId} approved. It is offered to every problem from the next session; it is advice that a draw may withhold, and no claim's status changes.`
        : `${by}: lesson ${lesson.nodeId} rejected. It stays in the journal and is never shown.`,
    );
    return 0;
  } finally {
    journal.close();
  }
}
