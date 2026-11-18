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

/**
 * Whether `harness ui` opens the browser when neither `--open` nor `--no-open` is given (UX14): only for a person at a terminal
 * (standard output is a TTY, so a test or a script that starts the command never opens one) on a machine with a display: macOS,
 * Windows, or a Linux or BSD session with `DISPLAY` or `WAYLAND_DISPLAY` (not a server over SSH).
 */
export function opensByDefault(o: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; tty: boolean }): boolean {
  if (!o.tty) return false;
  if (o.platform === "darwin" || o.platform === "win32") return true;
  return (o.env.DISPLAY ?? "") !== "" || (o.env.WAYLAND_DISPLAY ?? "") !== "";
}

/** `harness ui [--port N] [--open | --no-open]`: starts the local server and waits until it is told to stop. */
export async function uiCommand(o: UiCommandOptions): Promise<number> {
  const server = await startServer({ port: o.port ?? 0, ...(o.runsDir !== undefined ? { runsDir: o.runsDir } : {}), log: (line) => o.out(`ui: ${line}`) });
  o.out(`Seshat is on ${server.origin} (this machine only).`);
  o.out(`Open this address once, in your browser; it carries a token for this session:`);
  o.out(`  ${server.url}`);
  o.out(`Stop with Ctrl-C: the commands this page started are stopped too.`);
  if (o.open === true) {
    o.out(`Opening it in your browser (--no-open keeps it closed).`);
    openBrowser(server.url);
  }
  await (o.stopped ??
    new Promise<void>((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    }));
  await server.close();
  return 0;
}
