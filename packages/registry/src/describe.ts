import type { CapabilityManifest } from "./manifest.ts";
import type { JsonSchema } from "./schema.ts";

/**
 * A manifest written out for a model: what the capability does, when to use it and when not, the
 * fields of its input and output, and its examples.
 */
export function describeCapability(manifest: CapabilityManifest): string {
  const lines = [`${manifest.id}: ${manifest.title}`, "", manifest.description.trim()];
  if (manifest.when.length > 0) lines.push("", "Use it for:", ...manifest.when.map((w) => `- ${w}`));
  if (manifest.whenNot.length > 0) lines.push("", "Do not use it for:", ...manifest.whenNot.map((w) => `- ${w}`));
  lines.push("", "Input:", ...fields(manifest.input), "", "Output:", ...fields(manifest.output));
  for (const example of manifest.examples ?? []) {
    lines.push("", `Example: ${example.title}`, `  input: ${JSON.stringify(example.input)}`);
    if (example.output !== undefined) lines.push(`  output: ${JSON.stringify(example.output)}`);
    if (example.note !== undefined) lines.push(`  ${example.note}`);
  }
  return lines.join("\n");
}

/** The top-level fields of an object schema, one per line with their descriptions. */
function fields(schema: JsonSchema): string[] {
  if (schema.properties === undefined) return [`  ${renderSchema(schema)}`];
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, sub]) => {
    const head = `  ${name}${required.has(name) ? "" : "?"}: ${renderSchema(sub)}`;
    return sub.description !== undefined ? `${head}. ${sub.description}` : head;
  });
}

/** A schema in a compact, TypeScript-like notation: `{id: string, code: string}[]`. */
export function renderSchema(schema: JsonSchema): string {
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum !== undefined) return schema.enum.map((option) => JSON.stringify(option)).join(" | ");
  if (schema.anyOf !== undefined) return schema.anyOf.map(renderSchema).join(" | ");
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length === 0) return "any";
  return types
    .map((type) => {
      switch (type) {
        case "array": {
          const item = schema.items === undefined ? "any" : renderSchema(schema.items);
          return /[ |]/.test(item) && !item.startsWith("{") ? `(${item})[]` : `${item}[]`;
        }
        case "object": {
          if (schema.properties === undefined) {
            const value = typeof schema.additionalProperties === "object" ? renderSchema(schema.additionalProperties) : "any";
            return `{[key: string]: ${value}}`;
          }
          const required = new Set(schema.required ?? []);
          const parts = Object.entries(schema.properties).map(
            ([name, sub]) => `${name}${required.has(name) ? "" : "?"}: ${renderSchema(sub)}`,
          );
          return `{${parts.join(", ")}}`;
        }
        default:
          return type;
      }
    })
    .join(" | ");
}
