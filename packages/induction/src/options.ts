import type { JsonObject } from "@seshat/lines";

/** Reads a line's options, checked: a hook that reads a bad value fails with the name of the option. */
export function optionReader(line: string, raw: Readonly<JsonObject>): {
  integer: (key: string, min: number, max: number) => number;
  flag: (key: string) => boolean;
  text: (key: string) => string;
  list: (key: string) => unknown[];
} {
  return {
    integer(key, min, max) {
      const value = raw[key];
      if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
        throw new RangeError(`option ${line}.${key} is an integer from ${min} to ${max}, not ${JSON.stringify(value)}`);
      }
      return value;
    },
    flag(key) {
      const value = raw[key];
      if (typeof value !== "boolean") throw new TypeError(`option ${line}.${key} is true or false, not ${JSON.stringify(value)}`);
      return value;
    },
    text(key) {
      const value = raw[key];
      if (typeof value !== "string") throw new TypeError(`option ${line}.${key} is a text, not ${JSON.stringify(value)}`);
      return value;
    },
    list(key) {
      const value = raw[key];
      if (!Array.isArray(value)) throw new TypeError(`option ${line}.${key} is a list, not ${JSON.stringify(value)}`);
      return value;
    },
  };
}
