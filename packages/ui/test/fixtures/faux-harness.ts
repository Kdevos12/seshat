// `harness solve` with pi-ai's faux provider and a simulated Lean, for the test of a run started and stopped through the API. It speaks the
// interface's protocol (SESHAT_SIGNATURE, then a line on standard input) and stops on an interrupt as the real command does.
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { solve, SIGNATURE_LINE } from "@seshat/orchestrator";
import { createInterface } from "node:readline";
import { certifier } from "../../../orchestrator/test/resume-helpers.ts";
import { certifyingRegistry, check, DemoLean, fauxModels } from "../../../orchestrator/test/m0-helpers.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const { models, faux, name } = fauxModels();
const slow = process.env.FAUX_SLOW === "1";
// The formalization, then the prover: a proof that the simulated Lean accepts, or one that never ends (to be stopped).
faux.setResponses([fauxAssistantMessage([fauxText(JSON.stringify({ statement: "(n : ℕ) : n + 0 = n" }))]), check(slow ? "slow" : "exact trivial_proof")]);
const c = certifier();
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
const { readFileSync } = await import("node:fs");
const result = await solve({
  statement: readFileSync(args[1] as string, "utf8"),
  dir: flag("out") as string,
  models,
  model: name,
  maxUsd: Number(flag("max-usd")),
  user: "alice",
  registry: certifyingRegistry(c.certifier)(new DemoLean()),
  certifier: c.certifier,
  checker: new DemoLean(),
  signal: controller.signal,
  confirm: async (signature) => {
    console.log(`${SIGNATURE_LINE} ${JSON.stringify(signature)}`);
    const rl = createInterface({ input: process.stdin });
    const line = await new Promise<string | undefined>((resolve) => {
      rl.once("line", resolve);
      rl.once("close", () => resolve(undefined));
    });
    rl.close();
    return line?.trim() === "yes";
  },
  show: (line) => console.log(line),
});
console.log(`state: ${result.state}`);
process.exit(result.state === "declined" ? 1 : 0);
