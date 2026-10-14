import type { Json } from "@seshat/core";

export type JsonType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

/**
 * The subset of JSON Schema that manifests use for inputs and outputs. A manifest that uses any
 * other keyword is refused when it is loaded, so a schema never silently checks less than it says.
 */
export interface JsonSchema {
  type?: JsonType | JsonType[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: Json[];
  const?: Json;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  anyOf?: JsonSchema[];
  /** Documentation only. */
  default?: Json;
}

const TYPES: readonly JsonType[] = ["object", "array", "string", "number", "integer", "boolean", "null"];
const KEYWORDS = new Set([
  "type", "description", "properties", "required", "additionalProperties", "items", "enum", "const",
  "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "pattern", "anyOf", "default",
]);
const MAX_ERRORS = 20;

/** Problems with a schema itself: unknown keywords, wrong keyword values. Empty when it is usable. */
export function checkSchema(schema: unknown, path = "$"): string[] {
  const problems: string[] = [];
  walkSchema(schema, path, problems);
  return problems;
}

function walkSchema(schema: unknown, path: string, problems: string[]): void {
  if (!isPlainObject(schema)) {
    problems.push(`${path}: a schema must be an object`);
    return;
  }
  for (const [key, value] of Object.entries(schema)) {
    if (!KEYWORDS.has(key)) {
      problems.push(`${path}: unsupported keyword ${JSON.stringify(key)}`);
      continue;
    }
    switch (key) {
      case "type": {
        const types = Array.isArray(value) ? value : [value];
        if (types.length === 0 || types.some((t) => !TYPES.includes(t as JsonType))) {
          problems.push(`${path}.type: must be one of ${TYPES.join(", ")}, or a list of them`);
        }
        break;
      }
      case "properties":
        if (!isPlainObject(value)) problems.push(`${path}.properties: must be an object`);
        else for (const [name, sub] of Object.entries(value)) walkSchema(sub, `${path}.properties.${name}`, problems);
        break;
      case "required":
        if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
          problems.push(`${path}.required: must be a list of property names`);
        }
        break;
      case "additionalProperties":
        if (typeof value !== "boolean") walkSchema(value, `${path}.additionalProperties`, problems);
        break;
      case "items":
        walkSchema(value, `${path}.items`, problems);
        break;
      case "anyOf":
        if (!Array.isArray(value) || value.length === 0) problems.push(`${path}.anyOf: must be a non-empty list`);
        else value.forEach((sub, i) => walkSchema(sub, `${path}.anyOf[${i}]`, problems));
        break;
      case "enum":
        if (!Array.isArray(value) || value.length === 0) problems.push(`${path}.enum: must be a non-empty list`);
        break;
      case "pattern":
        if (typeof value !== "string") {
          problems.push(`${path}.pattern: must be a string`);
        } else {
          try {
            new RegExp(value, "u");
          } catch (error) {
            problems.push(`${path}.pattern: ${(error as Error).message}`);
          }
        }
        break;
      case "minimum":
      case "maximum":
        if (typeof value !== "number") problems.push(`${path}.${key}: must be a number`);
        break;
      case "minLength":
      case "maxLength":
      case "minItems":
      case "maxItems":
        if (!Number.isInteger(value) || (value as number) < 0) problems.push(`${path}.${key}: must be a natural number`);
        break;
      case "description":
        if (typeof value !== "string") problems.push(`${path}.description: must be a string`);
        break;
    }
  }
}

/**
 * Checks a JSON value against a schema. Returns the violations, each with the path of the value
 * (`$.snippets[0].code: expected string, got number`); an empty list means the value is valid.
 */
export function validate(schema: JsonSchema, value: unknown, path = "$"): string[] {
  const errors: string[] = [];
  check(schema, value, path, errors);
  return errors.length > MAX_ERRORS ? [...errors.slice(0, MAX_ERRORS), `... and ${errors.length - MAX_ERRORS} more`] : errors;
}

function check(schema: JsonSchema, value: unknown, path: string, errors: string[]): void {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => hasType(value, t))) {
      errors.push(`${path}: expected ${types.join(" or ")}, got ${typeName(value)}`);
      return;
    }
  }
  if (schema.const !== undefined && !jsonEqual(value, schema.const)) {
    errors.push(`${path}: must be ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum !== undefined && !schema.enum.some((option) => jsonEqual(value, option))) {
    errors.push(`${path}: must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}`);
  }
  if (schema.anyOf !== undefined) {
    const branches = schema.anyOf.map((sub) => {
      const sink: string[] = [];
      check(sub, value, path, sink);
      return sink;
    });
    if (!branches.some((sink) => sink.length === 0)) {
      // The closest shape is one whose type matched, with the fewest violations.
      const distance = (sink: string[]) => sink.length + (sink[0]?.startsWith(`${path}: expected `) ? 1000 : 0);
      const closest = branches.reduce((a, b) => (distance(b) < distance(a) ? b : a));
      errors.push(`${path}: matches none of the allowed shapes (closest: ${closest.join("; ")})`);
    }
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength} characters`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
      errors.push(`${path}: does not match /${schema.pattern}/`);
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: less than ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: greater than ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items !== undefined) value.forEach((item, i) => check(schema.items as JsonSchema, item, `${path}[${i}]`, errors));
  }
  if (isPlainObject(value)) {
    for (const name of schema.required ?? []) {
      if (!(name in value) || value[name] === undefined) errors.push(`${path}: missing property ${JSON.stringify(name)}`);
    }
    const properties = schema.properties ?? {};
    for (const [name, item] of Object.entries(value)) {
      if (item === undefined) continue;
      const sub = properties[name];
      if (sub !== undefined) {
        check(sub, item, `${path}.${name}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}: unexpected property ${JSON.stringify(name)}`);
      } else if (typeof schema.additionalProperties === "object") {
        check(schema.additionalProperties, item, `${path}.${name}`, errors);
      }
    }
  }
}

function hasType(value: unknown, type: JsonType): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
  }
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]));
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a).filter((k) => a[k] !== undefined);
    const other = Object.keys(b).filter((k) => b[k] !== undefined);
    return keys.length === other.length && keys.every((k) => jsonEqual(a[k], b[k]));
  }
  return false;
}
