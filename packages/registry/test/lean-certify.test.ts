import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type CertificationRequest, type CertificationResult, CertifyFailedError, Journal, readEvents, STANDARD_AXIOMS } from "@seshat/core";
import { type HealthAwareCertifier, type HostProfile, leanCertifyImplementation, loadCatalog, Registry, RegistryLeanCertifier } from "../src/index.ts";
import { tempDir } from "./helpers.ts";

const catalog = loadCatalog(new URL("../../../capabilities", import.meta.url).pathname);
const host: HostProfile = { host: "test", capabilities: { "lean.certify": { use: ["lake"] } } };
const VERSION = "0.1.0+lean-v4.27.0+fc-bench-v1";

const request: CertificationRequest = {
  original: "theorem T : True := by\n  sorry\n",
  candidate: "theorem T : True := by\n  trivial\n",
  target: "T",
  allowedAxioms: STANDARD_AXIOMS,
};
const certified: CertificationResult = { verdict: "certified", reasons: [], axioms: [], timeMs: 12 };

/** A certifier that answers with what it is given, and keeps what it was asked. */
class Scripted implements HealthAwareCertifier {
  readonly implementation = "scripted";
  readonly version = "0";
  readonly asked: { request: CertificationRequest; timeoutSec: number | undefined }[] = [];
  private readonly answer: (signal: AbortSignal | undefined) => Promise<CertificationResult>;
  constructor(answer: (signal: AbortSignal | undefined) => Promise<CertificationResult> = async () => certified) {
    this.answer = answer;
  }
  async certify(r: CertificationRequest, options: { timeoutSec?: number; signal?: AbortSignal } = {}): Promise<CertificationResult> {
    this.asked.push({ request: r, timeoutSec: options.timeoutSec });
    return this.answer(options.signal);
  }
}

const registryOf = (certifier: HealthAwareCertifier, profile: HostProfile = host, journal?: Journal) =>
  new Registry({ catalog, host: profile, factories: { "lake-certify": () => leanCertifyImplementation(certifier) }, ...(journal !== undefined ? { journal } : {}) });

describe("lean.certify through the registry", () => {
  it("gives the verdict back, with every certification a recorded tool run of the host's implementation", async () => {
    const dir = tempDir();
    const journal = Journal.open(dir, "run_certify");
    try {
      const scripted = new Scripted(async () => ({ verdict: "rejected", reasons: ["T does not state what the reference states"], axioms: ["propext"], timeMs: 9 }));
      const registry = registryOf(scripted, host, journal);
      const certifier = RegistryLeanCertifier.forHost(registry, { actor: "certifier" });
      assert.ok(certifier !== undefined);
      assert.deepEqual([certifier.implementation, certifier.version], ["lean.certify/lake", VERSION]);
      const result = await certifier.certify(request, { timeoutSec: 90.2 });
      assert.deepEqual(result, { verdict: "rejected", reasons: ["T does not state what the reference states"], axioms: ["propext"], timeMs: 9 });
      assert.deepEqual(scripted.asked, [{ request, timeoutSec: 91 }]);
      await certifier.certify(request);
      assert.equal(scripted.asked[1]?.timeoutSec, undefined);
      const events = readEvents(join(dir, "journal.jsonl")).filter((e) => e.type.startsWith("tool_run."));
      assert.deepEqual(
        events.map((e) => {
          const data = e.data as Record<string, unknown>;
          return [e.type, e.actor, e.type === "tool_run.started" ? `${data.capability}/${data.implementation}/${data.version}` : data.outcome];
        }),
        [
          ["tool_run.started", "certifier", `lean.certify/lake/${VERSION}`],
          ["tool_run.finished", "certifier", "ok"],
          ["tool_run.started", "certifier", `lean.certify/lake/${VERSION}`],
          ["tool_run.finished", "certifier", "ok"],
        ],
      );
    } finally {
      journal.close();
    }
  });

  it("is absent from a host that does not offer lean.certify", () => {
    const registry = new Registry({ catalog, host: { host: "bare", capabilities: {} } });
    assert.equal(RegistryLeanCertifier.forHost(registry), undefined);
  });

  it("turns a call that gave no verdict into a CertifyFailedError, never into rejected", async () => {
    const failing = async (error: Error) => {
      const certifier = RegistryLeanCertifier.forHost(registryOf(new Scripted(async () => Promise.reject(error)))) as RegistryLeanCertifier;
      try {
        await certifier.certify(request);
      } catch (e) {
        assert.ok(e instanceof CertifyFailedError, String(e));
        return e;
      }
      throw new assert.AssertionError({ message: "the certification did not fail" });
    };
    const crashed = await failing(new Error("the replay program ended with code 134"));
    assert.equal(crashed.reason, "failed");
    assert.match(crashed.message, /lean\.certify\/lake failed: the replay program ended with code 134/);
    const slow = await failing(new CertifyFailedError("timeout", "the certification took longer than its limit of 5 s"));
    assert.equal(slow.reason, "failed", "the implementation's own limit reaches the registry as a failure of the call");
    assert.match(slow.message, /took longer than its limit of 5 s/);
    const missing = await failing(new CertifyFailedError("unavailable", "cannot start lake: ENOENT"));
    assert.equal(missing.reason, "unavailable");
    assert.match(missing.message, /no implementation could be reached \(lake: cannot start lake: ENOENT\)/);
  });

  it("times out and aborts in the registry's terms", async () => {
    const hanging = (signal: AbortSignal | undefined) =>
      new Promise<CertificationResult>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("stopped")), { once: true }));
    const quick: HostProfile = { host: "test", capabilities: { "lean.certify": { use: ["lake"], timeoutMs: 50 } } };
    const certifier = RegistryLeanCertifier.forHost(registryOf(new Scripted(hanging), quick)) as RegistryLeanCertifier;
    await assert.rejects(certifier.certify(request), (e: unknown) => e instanceof CertifyFailedError && e.reason === "timeout" && /timed out after 50 ms/.test(e.message));
    // Aborted once the certification is under way.
    const controller = new AbortController();
    let running: () => void = () => undefined;
    const started = new Promise<void>((resolve) => (running = resolve));
    const waiting = RegistryLeanCertifier.forHost(
      registryOf(new Scripted((signal) => (running(), hanging(signal)))),
    ) as RegistryLeanCertifier;
    const pending = waiting.certify(request, { signal: controller.signal });
    await started;
    controller.abort();
    await assert.rejects(pending, (e: unknown) => e instanceof CertifyFailedError && e.reason === "aborted");
  });

  it("refuses a verdict that breaks the output schema", async () => {
    const sloppy = new Scripted(async () => ({ verdict: "maybe" as never, reasons: [], axioms: [], timeMs: 1 }));
    const certifier = RegistryLeanCertifier.forHost(registryOf(sloppy)) as RegistryLeanCertifier;
    await assert.rejects(certifier.certify(request), (e: unknown) => e instanceof CertifyFailedError && e.reason === "failed" && /invalid output/.test(e.message));
  });

  it("does not hide a request the capability refuses: that is the caller's mistake", async () => {
    const certifier = RegistryLeanCertifier.forHost(registryOf(new Scripted())) as RegistryLeanCertifier;
    await assert.rejects(certifier.certify({ ...request, candidate: "" }), (e: unknown) => !(e instanceof CertifyFailedError) && /invalid input for lean\.certify/.test(String(e)));
  });

  it("reports whether the certifier can run Lean in its health check, with the certifier's reason", async () => {
    const down = Object.assign(new Scripted(), { health: async () => ({ ok: false, detail: "lean cannot compile the probe file: unknown module prefix 'FormalConjectures'" }) });
    const [bad] = await registryOf(down).health("lean.certify");
    assert.deepEqual([bad?.ok, bad?.detail], [false, "lean cannot compile the probe file: unknown module prefix 'FormalConjectures'"]);
    const silent = Object.assign(new Scripted(), { health: async () => ({ ok: false }) });
    const [mute] = await registryOf(silent).health("lean.certify");
    assert.deepEqual([mute?.ok, mute?.detail], [false, "scripted cannot run Lean in its project"]);
    const up = Object.assign(new Scripted(), { health: async () => ({ ok: true, detail: "Lean (version 4.27.0)" }) });
    const [good] = await registryOf(up).health("lean.certify");
    assert.deepEqual([good?.ok, good?.detail], [true, "scripted 0: Lean (version 4.27.0)"]);
    const plain = Object.assign(new Scripted(), { health: async () => ({ ok: true }) });
    const [fine] = await registryOf(plain).health("lean.certify");
    assert.deepEqual([fine?.ok, fine?.detail], [true, "scripted 0"]);
  });
});
