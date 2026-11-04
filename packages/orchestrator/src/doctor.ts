import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Models } from "@earendil-works/pi-ai";
import type { HostProfile } from "@seshat/registry";
import { PriceBook } from "./prices.ts";
import { blendedPrice, cheapestModel } from "./student.ts";

/**
 * `harness doctor` (plan change PB6, documentation/quickstart.md, "harness doctor"): what this machine has and lacks to solve a problem,
 * in plain words, with what to do about each lack. It changes nothing but one file: when it finds a way to isolate the certifier it
 * writes the host profile that uses it (never over an existing one). It does not weaken Ruling 22: without isolation it writes no
 * profile and says that results stay `computed`; no profile it writes sets `unsandboxed`.
 */

export type CheckStatus = "ok" | "warn" | "missing";

export interface Check {
  id: "lean" | "kimina" | "credentials" | "prices" | "network" | "isolation";
  status: CheckStatus;
  title: string;
  /** What was found, in plain words. */
  detail: string;
  /** What to do about it, when something is missing. */
  fix?: string;
}

/** What doctor asks of the machine. Tests give their own; `realSystem` is the machine. */
export interface DoctorSystem {
  env: Readonly<Record<string, string | undefined>>;
  /** The path of an executable found on PATH. */
  which(command: string): string | undefined;
  /** Runs a command with a time limit; a command that cannot start is code -1. */
  run(command: string, args: readonly string[], timeoutMs?: number): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Any HTTP answer is `status`; no answer is `error`. */
  http(url: string, timeoutMs?: number): Promise<{ status: number } | { error: string }>;
  /** The user and group of this process, for a container started as the same user. */
  ids(): { uid: number; gid: number } | undefined;
}

export function realSystem(): DoctorSystem {
  return {
    env: process.env,
    which(command) {
      for (const dir of (process.env.PATH ?? "").split(delimiter)) {
        if (dir === "") continue;
        const path = join(dir, command);
        try {
          accessSync(path, constants.X_OK);
          return path;
        } catch {
          // not here
        }
      }
      return undefined;
    },
    run(command, args, timeoutMs = 15_000) {
      return new Promise((resolve) => {
        execFile(command, [...args], { timeout: timeoutMs, encoding: "utf8" }, (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? ((error as unknown as { code: number }).code) : -1;
          resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (error?.message ?? "") });
        });
      });
    },
    async http(url, timeoutMs = 8000) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        await response.body?.cancel().catch(() => {});
        return { status: response.status };
      } catch (error) {
        const cause = (error as { cause?: { code?: string; message?: string } }).cause;
        return { error: cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error)) };
      }
    },
    ids() {
      return typeof process.getuid === "function" && typeof process.getgid === "function" ? { uid: process.getuid(), gid: process.getgid() } : undefined;
    },
  };
}

/** The container image the Docker recipe of documentation/certifier.md uses, unless `SESHAT_LEAN_IMAGE` names another. */
export const DEFAULT_LEAN_IMAGE = "seshat-lean:4.27.0";

/** The address space the bubblewrap recipe allows: a cap on a runaway allocation, as documentation/certifier.md explains. */
const ADDRESS_SPACE = "--as=68719476736";

/** A sandbox recipe of documentation/certifier.md, ready for a host profile's `lean.certify` settings. */
export interface Recipe {
  tool: "bubblewrap" | "docker";
  sandbox: string[];
  /** Settings of the `lake` implementation besides `sandbox`. */
  command?: string;
}

export function bubblewrapRecipe(): Recipe {
  return {
    tool: "bubblewrap",
    sandbox: [
      "prlimit", ADDRESS_SPACE, "--cpu=1800", "--",
      "bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
      "--bind", "{work}", "{work}", "--unshare-net", "--unshare-pid", "--die-with-parent", "--",
    ],
  };
}

export function dockerRecipe(image: string, ids: { uid: number; gid: number }): Recipe {
  return {
    tool: "docker",
    command: "/opt/elan/bin/lake",
    sandbox: [
      "docker", "run", "--rm", "--network", "none", "--memory", "16g", "--memory-swap", "16g",
      "--pids-limit", "512", "--read-only", "--tmpfs", "/tmp", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges", "--user", `${ids.uid}:${ids.gid}`,
      "-v", "{project}:{project}:ro", "-v", "{work}:{work}", "-w", "{project}",
      "-e", "ELAN_HOME=/opt/elan", image,
    ],
  };
}

export interface DoctorOptions {
  system: DoctorSystem;
  models: Models;
  /** The host profile in use, and its name. */
  profile: HostProfile;
  /** The model the user named; absent: the cheapest priced model of the providers with credentials. */
  model?: string;
  /** The Lean project the certifier runs in (`LEAN_PROJECT_DIR`, or a built environment's); undefined when there is none. */
  leanProject?: string | undefined;
  /** The `config` directory: `hosts/local.json` is the base of the profile doctor writes, which goes to `hosts/NAME.json`. */
  configDir: string;
  /** Whether to write the isolation profile: `auto` when none exists, `rewrite` over an existing one, `never` for a check only. Default `auto`. */
  write?: "auto" | "rewrite" | "never";
  /** The name of the profile it writes. Default `sandboxed`. */
  profileName?: string;
}

export interface DoctorReport {
  host: string;
  checks: Check[];
  /** False when something that a run needs is missing. A missing isolation is a warning: the run can still reach `computed`. */
  ok: boolean;
  /** The isolation profile: where it is, whether this call wrote it, and what it uses. */
  isolation?: { profile: string; path: string; written: boolean; tool: Recipe["tool"] };
  /** The model a `solve` would use, and why. */
  model?: { name: string; price: number; chosen: "named" | "cheapest" };
}

export const DEFAULT_PROFILE_NAME = "sandboxed";

function kiminaUrl(env: DoctorSystem["env"]): string {
  const given = env.LEAN_SERVER_API_URL;
  return given !== undefined && given !== "" ? given : "http://localhost:8000";
}

/** Runs every check, in the order a person would fix them. */
export async function doctor(o: DoctorOptions): Promise<DoctorReport> {
  const { system, profile } = o;
  const checks: Check[] = [];

  // 1. Lean and the project the certifier runs in.
  const lake = system.which("lake");
  if (lake === undefined) {
    checks.push({
      id: "lean",
      status: "missing",
      title: "Lean",
      detail: "Lean 4 is not installed here: there is no `lake` on your PATH. The certifier, which is what turns a proof into a result, runs Lean on this machine.",
      fix: "Install Lean with elan (https://github.com/leanprover/elan), open a new terminal, and run `lake --version`. Then `pnpm harness lean-env build` builds the project the proofs are checked in.",
    });
  } else if (o.leanProject === undefined) {
    checks.push({
      id: "lean",
      status: "missing",
      title: "Lean",
      detail: `Lean is installed (${lake}), but there is no Lean project for the certifier: LEAN_PROJECT_DIR is not set and the default environment is not built.`,
      fix: "Run `pnpm harness lean-env build` (it downloads Mathlib, several gigabytes), or set LEAN_PROJECT_DIR to a Lean project that has Mathlib.",
    });
  } else {
    const version = await system.run("lake", ["--version"], 15_000);
    checks.push({
      id: "lean",
      status: "ok",
      title: "Lean",
      detail: `${version.code === 0 ? version.stdout.trim().split("\n")[0] : "lake is installed"} (${lake}); the certifier's project is ${o.leanProject}.`,
    });
  }

  // 2. The Kimina server, which checks every proof the models write.
  const url = kiminaUrl(system.env);
  const health = await system.http(`${url.replace(/\/+$/, "")}/health`);
  if ("error" in health) {
    checks.push({
      id: "kimina",
      status: "missing",
      title: "Kimina Lean server",
      detail: `Nothing answers at ${url} (${health.error}). Every proof a model writes is checked by this server, so a run cannot start without it.`,
      fix: "Start a Kimina Lean server (documentation/lean.md says how, with Docker or without), or set LEAN_SERVER_API_URL to the address of one that is running.",
    });
  } else if (health.status === 401 || health.status === 403) {
    checks.push({
      id: "kimina",
      status: "missing",
      title: "Kimina Lean server",
      detail: `${url} answers, and refuses this machine (HTTP ${health.status}): the server wants a key.`,
      fix: "Set LEAN_SERVER_API_KEY to the key of that server.",
    });
  } else if (health.status >= 400) {
    checks.push({
      id: "kimina",
      status: "missing",
      title: "Kimina Lean server",
      detail: `${url}/health answered HTTP ${health.status}, which is not what a Kimina server says.`,
      fix: "Check that LEAN_SERVER_API_URL points at a Kimina Lean server, and that it is running.",
    });
  } else {
    checks.push({ id: "kimina", status: "ok", title: "Kimina Lean server", detail: `${url} answers.` });
  }

  // 3. Model credentials, and 4. the price table.
  const prices = new PriceBook(profile.models);
  const available = await o.models.getAvailable().catch(() => []);
  let chosen: DoctorReport["model"];
  let chosenModel: (typeof available)[number] | undefined;
  if (available.length === 0) {
    checks.push({
      id: "credentials",
      status: "missing",
      title: "Model credentials",
      detail: "No model provider has credentials, so no model can be asked anything.",
      fix: "Set the API key of one provider in your environment (`pnpm harness models` lists the providers and shows which have credentials; pi-ai's README names the variable each one reads). A key is enough: nothing else is configured.",
    });
  } else {
    const providers = [...new Set(available.map((m) => m.provider))].sort();
    checks.push({ id: "credentials", status: "ok", title: "Model credentials", detail: `${providers.length} provider(s) have credentials: ${providers.join(", ")}.` });
    if (o.model !== undefined) {
      chosenModel = available.find((m) => `${m.provider}/${m.id}` === o.model);
      if (chosenModel === undefined) {
        checks.push({
          id: "prices",
          status: "missing",
          title: "Price table",
          detail: `The model ${o.model} is not one of the models your credentials give access to.`,
          fix: "Name a model that `pnpm harness models PROVIDER` lists for a provider with credentials, or leave --model out so that the cheapest priced one is used.",
        });
      } else {
        chosen = { name: o.model, price: blendedPrice(chosenModel, prices), chosen: "named" };
      }
    } else {
      const cheapest = await cheapestModel(o.models, prices);
      chosenModel = cheapest === undefined ? undefined : available.find((m) => `${m.provider}/${m.id}` === cheapest.name);
      if (cheapest !== undefined) chosen = { name: cheapest.name, price: cheapest.price, chosen: "cheapest" };
    }
    if (chosen !== undefined && chosenModel !== undefined) {
      if (chosen.price > 0) {
        const fromHost = prices.pricingOf(chosenModel) !== undefined;
        checks.push({
          id: "prices",
          status: "ok",
          title: "Price table",
          detail: `${chosen.name} (${chosen.chosen === "named" ? "the model you named" : "the cheapest priced model you can use"}) costs $${chosen.price.toFixed(2)} per million tokens, input plus output, from ${fromHost ? `the host profile ${profile.host}` : "pi-ai's table"}. A dollar cap can see its cost.`,
        });
      } else {
        checks.push({
          id: "prices",
          status: "missing",
          title: "Price table",
          detail: `${chosen.name} has no price in the host profile or in pi-ai, so every response would be charged $0 and no dollar cap could ever stop the run.`,
          fix: `Give it an entry in "models" of config/hosts/${profile.host}.json (cacheHit, cacheMiss and output, in dollars per million tokens; documentation/m0-loop.md, "Prices"), or choose a priced model with --model.`,
        });
      }
    } else if (o.model === undefined) {
      checks.push({
        id: "prices",
        status: "missing",
        title: "Price table",
        detail: "None of the models you can use has a price, in the host profile or in pi-ai, so no dollar cap could see what they cost.",
        fix: `Give the model you mean to use an entry in "models" of config/hosts/${profile.host}.json (documentation/m0-loop.md, "Prices"), and name it with --model.`,
      });
    }
  }

  // 5. The network, as far as the model's provider.
  if (chosenModel === undefined) {
    checks.push({ id: "network", status: "warn", title: "Network", detail: "Not checked: there is no model to reach until the credentials and prices above are fixed." });
  } else {
    const reached = await system.http(chosenModel.baseUrl);
    checks.push(
      "error" in reached
        ? {
            id: "network",
            status: "missing",
            title: "Network",
            detail: `${chosenModel.baseUrl}, the address of ${chosenModel.provider}, cannot be reached from this machine (${reached.error}).`,
            fix: "Check your connection, a firewall or a proxy. A proxy has to be set for Node as well (for example NODE_USE_ENV_PROXY=1 with HTTPS_PROXY set).",
          }
        : { id: "network", status: "ok", title: "Network", detail: `${chosenModel.baseUrl} answers (HTTP ${reached.status}).` },
    );
  }

  // 6. The certifier's isolation.
  const isolation = await isolationCheck(o, checks);

  return { host: profile.host, checks, ok: !checks.some((c) => c.status === "missing"), ...(isolation !== undefined ? { isolation } : {}), ...(chosen !== undefined ? { model: chosen } : {}) };
}

/** What the host profile in use says of the certifier's sandbox. */
function sandboxOf(profile: HostProfile): { sandbox: readonly string[]; unsandboxed: boolean } | undefined {
  const binding = profile.capabilities["lean.certify"];
  if (binding === undefined) return undefined;
  const lake = binding.settings?.lake as { sandbox?: unknown; unsandboxed?: unknown } | undefined;
  return { sandbox: Array.isArray(lake?.sandbox) ? (lake.sandbox as string[]) : [], unsandboxed: lake?.unsandboxed === true };
}

async function isolationCheck(o: DoctorOptions, checks: Check[]): Promise<DoctorReport["isolation"]> {
  const { system, profile } = o;
  const title = "Certifier isolation";
  const name = o.profileName ?? DEFAULT_PROFILE_NAME;
  const path = join(o.configDir, "hosts", `${name}.json`);
  const current = sandboxOf(profile);
  if (current === undefined) {
    checks.push({ id: "isolation", status: "warn", title, detail: `The host profile ${profile.host} has no lean.certify: nothing is certified on this host, and every proof that passes the fast check stays \`computed\`.`, fix: "Use a host profile that lists lean.certify (config/hosts/local.json)." });
    return undefined;
  }
  if (current.sandbox.length > 0) {
    checks.push({ id: "isolation", status: "ok", title, detail: `The host profile ${profile.host} runs the certifier behind \`${current.sandbox[0]}\`: a candidate's code cannot reach your files or your network.` });
    return undefined;
  }
  if (current.unsandboxed) {
    checks.push({
      id: "isolation",
      status: "warn",
      title,
      detail: `The host profile ${profile.host} runs the certifier unsandboxed, as you: a candidate's code can read and write your files and use your network. You chose that; doctor does not.`,
      fix: "Run `pnpm harness doctor` on a host profile without `unsandboxed`, to get an isolated one.",
    });
    return undefined;
  }

  // The certifier is not made without isolation. What isolation does this machine have?
  const found: Recipe[] = [];
  const why: string[] = [];
  const bwrap = system.which("bwrap");
  const prlimit = system.which("prlimit");
  if (bwrap !== undefined) {
    const probe = await system.run("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--unshare-net", "--unshare-pid", "--die-with-parent", "true"], 15_000);
    if (probe.code !== 0) why.push(`bubblewrap is installed (${bwrap}) but cannot make a sandbox here: ${(probe.stderr || probe.stdout).trim().split("\n")[0] || `exit ${probe.code}`}. Unprivileged user namespaces may be switched off on this system.`);
    else if (prlimit === undefined) why.push("bubblewrap works, but `prlimit` (util-linux) is missing, and the recipe caps memory with it: install util-linux.");
    else found.push(bubblewrapRecipe());
  }
  const docker = system.which("docker");
  const image = system.env.SESHAT_LEAN_IMAGE !== undefined && system.env.SESHAT_LEAN_IMAGE !== "" ? system.env.SESHAT_LEAN_IMAGE : DEFAULT_LEAN_IMAGE;
  const ids = system.ids();
  if (docker !== undefined && found.length === 0) {
    const info = await system.run("docker", ["info"], 15_000);
    if (info.code !== 0) why.push(`Docker is installed (${docker}) but its daemon does not answer: start Docker.`);
    else if ((await system.run("docker", ["image", "inspect", image], 15_000)).code !== 0) why.push(`Docker works, but the image ${image} is not built here: documentation/certifier.md (recipe 3) says what it holds. Build it, or set SESHAT_LEAN_IMAGE to yours.`);
    else if (ids === undefined) why.push("Docker works, but this system gives no user id to run the container as.");
    else found.push(dockerRecipe(image, ids));
  }
  const recipe = found[0];
  if (recipe === undefined) {
    checks.push({
      id: "isolation",
      status: "warn",
      title,
      detail:
        `This machine has no isolation for the certifier${why.length > 0 ? ` (${why.join(" ")})` : " (no bubblewrap and no Docker found)"}. The certifier refuses to run a candidate's code without it, so ` +
        "**every proof that passes the fast check stays `computed`: no claim can become `proved` or `refuted`.** The run still works and says so in RESULT.md.",
      fix: "Install bubblewrap (`apt install bubblewrap`, or your system's package) or Docker, then run `pnpm harness doctor` again: it writes the host profile that uses it.",
    });
    return undefined;
  }

  // Write the profile that uses it.
  const existed = existsSync(path);
  const mode = o.write ?? "auto";
  let written = false;
  if (mode !== "never" && (!existed || mode === "rewrite")) {
    const base = JSON.parse(readFileSync(join(o.configDir, "hosts", "local.json"), "utf8")) as HostProfile & { description?: string };
    const lake = (base.capabilities["lean.certify"]?.settings?.lake ?? {}) as Record<string, unknown>;
    const next = {
      ...base,
      host: name,
      description: `Generated by \`harness doctor\`: the local host with the certifier behind ${recipe.tool}, so that a proof can reach \`proved\`. Written once and never over an existing file; delete it to have it made again. ${base.description ?? ""}`.trim(),
      capabilities: {
        ...base.capabilities,
        "lean.certify": {
          ...base.capabilities["lean.certify"],
          use: ["lake"],
          settings: { lake: { ...lake, ...(recipe.command !== undefined ? { command: recipe.command } : {}), sandbox: recipe.sandbox } },
        },
      },
    };
    mkdirSync(join(o.configDir, "hosts"), { recursive: true });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
    written = true;
  }
  checks.push({
    id: "isolation",
    status: "ok",
    title,
    detail: written
      ? `${recipe.tool} works here. Wrote ${path}, the host profile that runs the certifier inside it (no network, your files read-only). Use it with --host ${name}, or HARNESS_HOST=${name}; \`harness solve\` uses it by itself when it exists.`
      : existed
        ? `${recipe.tool} works here, and ${path} already exists: it was not touched. Use it with --host ${name}.`
        : `${recipe.tool} works here. No profile was written (--no-write); ${path} would hold the certifier behind it.`,
    ...(!written && !existed ? { fix: `Run \`pnpm harness doctor\` without --no-write to write ${path}.` } : {}),
  });
  return { profile: name, path, written, tool: recipe.tool };
}

/** The report as lines of text: one block per check, the fix indented under what is missing. */
export function renderDoctor(report: DoctorReport): string[] {
  const mark: Record<CheckStatus, string> = { ok: "ok     ", warn: "warning", missing: "MISSING" };
  const lines = [`Seshat doctor, host ${report.host}`, ""];
  for (const c of report.checks) {
    lines.push(`${mark[c.status]}  ${c.title}: ${c.detail}`);
    if (c.fix !== undefined) lines.push(`         What to do: ${c.fix}`);
  }
  lines.push("");
  const missing = report.checks.filter((c) => c.status === "missing");
  if (missing.length > 0) lines.push(`${missing.length} thing(s) a run needs are missing: ${missing.map((c) => c.title).join(", ")}. Fix them in this order and run \`pnpm harness doctor\` again.`);
  else lines.push("Everything a run needs is here.");
  if (report.checks.some((c) => c.id === "isolation" && c.status === "warn")) lines.push("Without isolation for the certifier, a run can only reach `computed`; it will say so.");
  if (report.model !== undefined) lines.push(`A solve would use ${report.model.name} (${report.model.chosen === "named" ? "named by you" : "the cheapest priced model you can use"}).`);
  return lines;
}
