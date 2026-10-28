import assert from "node:assert/strict";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import {
  type CertificationRequest,
  type CertificationResult,
  type HarnessEvent,
  type LeanCertifier,
  verifyChain,
} from "@seshat/core";
import { ofType } from "./m0-helpers.ts";

/** The text of the first user message of a request: the session prompt. */
export function sessionPromptOf(context: TranscriptContext): string {
  const first = context.messages.find((m) => m.role === "user");
  if (first?.role !== "user") return "";
  return typeof first.content === "string" ? first.content : first.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

/** The index of the `n`th event of a type (from 1). */
export function nth(events: readonly HarnessEvent[], type: HarnessEvent["type"], n: number): number {
  const found = events.flatMap((event, index) => (event.type === type ? [index] : []))[n - 1];
  assert.ok(found !== undefined, `the journal has no ${type} number ${n}`);
  return found;
}

export const sum = (numbers: readonly number[]): number => numbers.reduce((total, n) => total + n, 0);

/** What the model calls of a journal cost: the sum of the charges, and the sum of the costs the attempts ended with. */
export function spent(events: readonly HarnessEvent[]): { charged: number; attempts: number } {
  return {
    charged: sum(ofType(events, "attempt.charged").map((e) => e.data.usd)),
    attempts: sum(ofType(events, "attempt.finished").map((e) => e.data.usd)),
  };
}

/** A fake certifier that certifies, and counts what it was asked. */
export function certifier(): { requests: CertificationRequest[]; certifier: LeanCertifier } {
  const requests: CertificationRequest[] = [];
  return {
    requests,
    certifier: {
      implementation: "fake-certifier",
      version: "0",
      certify: async (request): Promise<CertificationResult> => {
        requests.push(request);
        return { verdict: "certified", reasons: [], axioms: ["propext"], timeMs: 1 };
      },
    },
  };
}

/** A fact that holds of every journal a resumed run leaves, however it was cut. */
export function assertSound(events: readonly HarnessEvent[]): void {
  assert.deepEqual(verifyChain(events), { ok: true });
  const started = new Set(ofType(events, "attempt.started").map((e) => e.data.attemptId));
  const ended = ofType(events, "attempt.finished").map((e) => e.data.attemptId);
  assert.deepEqual([...started].sort(), [...ended].sort(), "every session that began has ended, once");
  assert.equal(
    ofType(events, "tool_run.started").length,
    ofType(events, "tool_run.finished").length,
    "every tool run that began has ended",
  );
  for (const event of events) {
    if (event.type.startsWith("task.") || event.type === "run.resumed") assert.equal(event.actor, "orchestrator", `${event.type} is the orchestrator's`);
  }
  const { charged, attempts } = spent(events);
  assert.ok(Math.abs(charged - attempts) < 1e-9, `the sessions are billed what the model calls cost: ${charged} against ${attempts}`);
}


/**
 * How many model responses a journal's prefix consumed: one for each response a session was charged
 * for and one for each one-shot call of a line. A resumed process given the script from this
 * position goes on where the first one stopped, when it stopped between two sessions.
 */
export function consumed(events: readonly HarnessEvent[]): number {
  return ofType(events, "attempt.charged").length + ofType(events, "model_call.finished").length;
}

/**
 * The cuts that fall between two sessions: right after a session's end and the routing decisions that
 * follow it, where the process that ended had nothing in flight, so that the resumed one goes on
 * exactly where the first would have.
 */
export function boundaries(events: readonly HarnessEvent[]): number[] {
  return events.flatMap((event, index) => {
    if (event.type !== "attempt.finished") return [];
    // After every routing decision of the attempt: a guard's finding can add a second one to the first.
    let end = index + 1;
    while (events[end]?.type === "task.routed") end += 1;
    return [end];
  });
}
