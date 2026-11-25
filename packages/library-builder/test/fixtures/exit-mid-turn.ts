// Starts the fake ACP agent (scenario `deaf`, which ignores a cancel and the end of its input) through the ACP runner, waits until the agent has written
// its pid, and exits the process while the agent runs, as a harness ended by an error would. The test then checks that the agent is gone.
import { existsSync, readFileSync } from "node:fs";
import { acpAgentRunner } from "../../src/acp.ts";

const [agentScript, pidFile, cwd] = process.argv.slice(2) as [string, string, string];
void acpAgentRunner()([process.execPath, agentScript], { cwd, env: { PATH: process.env.PATH ?? "", FAKE_SCENARIO: "deaf", FAKE_PID: pidFile }, stdin: "prove it", timeoutMs: 60_000 });
const wait = setInterval(() => {
  if (existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "") {
    clearInterval(wait);
    process.exit(0);
  }
}, 20);
