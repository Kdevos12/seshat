#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { CapabilityError, CatalogError, runContract, type Registry } from "@math-harness/registry";
import { hostName, openRegistry } from "./implementations.ts";

const usage = `usage:
  harness capabilities [--host HOST]
  harness describe CAPABILITY
  harness health [CAPABILITY] [--host HOST]
  harness contract CAPABILITY [--host HOST] [--implementation ID] [--case NAME]... [--out FILE]

HOST defaults to HARNESS_HOST, then local (config/hosts/HOST.json).`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    host: { type: "string" },
    implementation: { type: "string" },
    case: { type: "string", multiple: true },
    out: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const [command, target] = positionals;

async function main(): Promise<number> {
  if (values.help || command === undefined) {
    console.log(usage);
    return command === undefined && !values.help ? 2 : 0;
  }
  let registry: Registry;
  try {
    registry = openRegistry({ host: hostName(values.host) });
  } catch (error) {
    if (error instanceof CatalogError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
  try {
    switch (command) {
      case "capabilities":
        return capabilities(registry);
      case "describe":
        if (target === undefined) break;
        console.log(registry.describe(target));
        return 0;
      case "health":
        return await health(registry, target);
      case "contract":
        if (target === undefined) break;
        return await contract(registry, target);
    }
    console.error(usage);
    return 2;
  } catch (error) {
    if (!(error instanceof CapabilityError)) throw error;
    console.error(error.message);
    return 2;
  } finally {
    await registry.close();
  }
}

function capabilities(registry: Registry): number {
  for (const { manifest } of registry.capabilities()) {
    const use = registry.host.capabilities[manifest.id]?.use;
    const where = use ? `${registry.host.host}: ${use.join(", ")}` : `not offered on ${registry.host.host}`;
    console.log(`${manifest.id} v${manifest.version} (${manifest.exposure}): ${manifest.title} [${where}]`);
  }
  return 0;
}

async function health(registry: Registry, id: string | undefined): Promise<number> {
  const entries = await registry.health(id);
  for (const e of entries) {
    console.log(`${e.ok ? "ok  " : "FAIL"} ${e.capability}/${e.implementation} ${e.version} (${e.durationMs} ms): ${e.detail}`);
  }
  if (entries.length === 0) console.log(`host ${registry.host.host} offers no capability`);
  return entries.every((e) => e.ok) ? 0 : 1;
}

async function contract(registry: Registry, id: string): Promise<number> {
  const report = await runContract(registry, id, {
    ...(values.implementation !== undefined ? { implementation: values.implementation } : {}),
    ...(values.case !== undefined ? { only: values.case } : {}),
    onCase: (c) => {
      console.log(`${c.passed ? "pass" : "FAIL"}  ${c.name} (${c.durationMs} ms)`);
      for (const failure of c.failures) console.log(`      ${failure}`);
    },
  });
  console.log(`${report.capability} on ${report.host} with ${report.implementation}: ${report.passed} passed, ${report.failed} failed`);
  if (values.out !== undefined) writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
  return report.failed === 0 ? 0 : 1;
}

process.exitCode = await main();
