import { fileURLToPath } from "node:url";
import { fauxFactory, jevFactory } from "@seshat/decide";
import { kiminaChecker, kiminaFactory } from "@seshat/lean-kimina";
import { lookupEnvironment } from "@seshat/lean-env";
import { leanLspFactory } from "@seshat/lean-lsp";
import { lakeCertifyFactory } from "@seshat/lean-local";
import { leanMetaFactory, pantographFactory } from "@seshat/lean-meta";
import { findstatFactory, lmfdbFactory, oeisFactory } from "@seshat/models";
import {
  CatalogError,
  hostProfilePath,
  interpolate,
  loadCatalog,
  loadHostProfile,
  MissingVariableError,
  Registry,
  type ImplementationFactory,
  type LeanEnvPin,
  type RegistryOptions,
} from "@seshat/registry";

/** The repository: `capabilities/` holds the manifests, `config/hosts/` the host profiles. */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Every in-process implementation, by the factory name manifests use. */
export const FACTORIES: Readonly<Record<string, ImplementationFactory>> = {
  kimina: kiminaFactory(),
  "kimina-meta": leanMetaFactory((context) => kiminaChecker(context)),
  "lean-lsp": leanLspFactory(),
  pantograph: pantographFactory(),
  "lake-certify": lakeCertifyFactory(),
  oeis: oeisFactory(),
  lmfdb: lmfdbFactory(),
  findstat: findstatFactory(),
  jev: jevFactory(),
  "decide-faux": fauxFactory(),
};

export interface OpenRegistryOptions extends Omit<RegistryOptions, "catalog" | "host" | "factories" | "leanEnv"> {
  /** Default: `HARNESS_HOST`, then `local`. */
  host?: string;
  catalogDir?: string;
  configDir?: string;
  factories?: Readonly<Record<string, ImplementationFactory>>;
  /** The Lean environment, in place of the one the host profile names (`LEAN_ENV`, default `base`). */
  leanEnv?: string;
  /** The directory with the environment files. Default: `lean/env/` of this repository. */
  envRoot?: string;
}

export function hostName(explicit?: string): string {
  return explicit || process.env.HARNESS_HOST || "local";
}

/**
 * The Lean environment a host runs against and where it stands on this machine: the name the host
 * profile gives (`leanEnv`, usually `${env:LEAN_ENV:-base}`) or `override`, looked up in `lean/env/`.
 * The project the harness's own Lean tools use is `LEAN_PROJECT_DIR` when it is set, and the
 * environment's project when that is built; the lock is read from that project, so the hash names the
 * project the tools really run in. Undefined for a host that names no environment.
 */
export function leanEnvPin(
  profile: { host: string; leanEnv?: string },
  options: { override?: string; envRoot?: string; env?: Readonly<Record<string, string | undefined>> } = {},
): { pin: LeanEnvPin; projectDir: string | undefined } | undefined {
  const env = options.env ?? process.env;
  let name = options.override;
  if (name === undefined && profile.leanEnv !== undefined) {
    try {
      name = interpolate(profile.leanEnv, { dir: "", env }).trim();
    } catch (error) {
      if (error instanceof MissingVariableError) throw new CatalogError([`host ${profile.host}: leanEnv: ${error.message}`]);
      throw error;
    }
  }
  if (name === undefined || name === "") return undefined;
  const given = env.LEAN_PROJECT_DIR !== undefined && env.LEAN_PROJECT_DIR !== "" ? env.LEAN_PROJECT_DIR : undefined;
  const pin = lookupEnvironment(name, { ...(options.envRoot !== undefined ? { root: options.envRoot } : {}), ...(given !== undefined ? { projectDir: given } : {}) });
  // The environment's own project is the default only once it is built: before that, Lake would fetch packages.
  return { pin, projectDir: given ?? (pin.status === "resolved" && pin.built === true ? pin.dir : undefined) };
}

/**
 * The Lean environment a host will be pinned to, with its hash from the lock, without building a
 * registry: what a run that starts on earlier journals compares them by before anything is written.
 * Undefined for a host that names none.
 */
export function hostLeanEnv(options: Pick<OpenRegistryOptions, "host" | "configDir" | "leanEnv" | "envRoot" | "env"> = {}): { name: string; hash: string | null } | undefined {
  const profile = loadHostProfile(hostProfilePath(options.configDir ?? `${REPO_ROOT}config`, hostName(options.host)));
  const found = leanEnvPin(profile, {
    ...(options.leanEnv !== undefined ? { override: options.leanEnv } : {}),
    ...(options.envRoot !== undefined ? { envRoot: options.envRoot } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  });
  return found === undefined ? undefined : { name: found.pin.name, hash: found.pin.hash };
}

/** The registry of this repository, for a host. */
export function openRegistry(options: OpenRegistryOptions = {}): Registry {
  const { host, catalogDir, configDir, factories, leanEnv, envRoot, env, ...rest } = options;
  const name = hostName(host);
  const config = configDir ?? `${REPO_ROOT}config`;
  const profile = loadHostProfile(hostProfilePath(config, name));
  const found = leanEnvPin(profile, { ...(leanEnv !== undefined ? { override: leanEnv } : {}), ...(envRoot !== undefined ? { envRoot } : {}), ...(env !== undefined ? { env } : {}) });
  const source = env ?? process.env;
  // The profiles read LEAN_PROJECT_DIR; a built environment is its default.
  const projectEnv = found?.projectDir !== undefined && (source.LEAN_PROJECT_DIR ?? "") === "" ? { ...source, LEAN_PROJECT_DIR: found.projectDir } : env;
  return new Registry({
    ...rest,
    catalog: loadCatalog(catalogDir ?? `${REPO_ROOT}capabilities`),
    host: profile,
    factories: factories ?? FACTORIES,
    ...(found !== undefined ? { leanEnv: found.pin } : {}),
    ...(projectEnv !== undefined ? { env: projectEnv } : {}),
  });
}
