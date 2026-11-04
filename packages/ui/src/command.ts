import { spawn } from "node:child_process";
import { startServer } from "./server.ts";

export interface UiCommandOptions {
  port?: number | undefined;
  /** Open the address in the default browser. */
  open?: boolean | undefined;
  runsDir?: string | undefined;
  out: (line: string) => void;
  /** Resolves when the server should stop (a signal); default: SIGINT or SIGTERM. */
  stopped?: Promise<void>;
}

function openBrowser(url: string): void {
  const [file, args]: [string, string[]] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(file, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The address is printed either way.
  }
}

/** `harness ui [--port N] [--open]`: starts the local server and waits until it is told to stop. */
export async function uiCommand(o: UiCommandOptions): Promise<number> {
  const server = await startServer({ port: o.port ?? 0, ...(o.runsDir !== undefined ? { runsDir: o.runsDir } : {}), log: (line) => o.out(`ui: ${line}`) });
  o.out(`Seshat is on ${server.origin} (this machine only).`);
  o.out(`Open this address once, in your browser; it carries a token for this session:`);
  o.out(`  ${server.url}`);
  o.out(`Stop with Ctrl-C: the commands this page started are stopped too.`);
  if (o.open === true) openBrowser(server.url);
  await (o.stopped ??
    new Promise<void>((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    }));
  await server.close();
  return 0;
}
