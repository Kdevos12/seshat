import { fileURLToPath } from "node:url";
import { kiminaChecker, kiminaFactory } from "@seshat/lean-kimina";
import { leanMetaFactory } from "@seshat/lean-meta";
import { Registry, type ImplementationFactory, type RegistryOptions } from "@seshat/registry";

/** The repository: `capabilities/` holds the manifests, `config/hosts/` the host profiles. */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Every in-process implementation, by the factory name manifests use. */
export const FACTORIES: Readonly<Record<string, ImplementationFactory>> = {
  kimina: kiminaFactory(),
  "kimina-meta": leanMetaFactory((context) => kiminaChecker(context)),
};

export interface OpenRegistryOptions extends Omit<RegistryOptions, "catalog" | "host" | "factories"> {
  /** Default: `HARNESS_HOST`, then `local`. */
  host?: string;
  catalogDir?: string;
  configDir?: string;
  factories?: Readonly<Record<string, ImplementationFactory>>;
}

export function hostName(explicit?: string): string {
  return explicit || process.env.HARNESS_HOST || "local";
}

/** The registry of this repository, for a host. */
export function openRegistry(options: OpenRegistryOptions = {}): Registry {
  const { host, catalogDir, configDir, factories, ...rest } = options;
  return Registry.load({
    ...rest,
    host: hostName(host),
    catalogDir: catalogDir ?? `${REPO_ROOT}capabilities`,
    configDir: configDir ?? `${REPO_ROOT}config`,
    factories: factories ?? FACTORIES,
  });
}
