import { useEffect, useState } from "preact/hooks";
import { get, message } from "./api.ts";
import { Notice } from "./ui.tsx";

/**
 * The settings panel of the start form. Nothing in it names a setting: it is drawn from `GET /api/parameters` (the catalogue of
 * `packages/orchestrator/src/parameters.ts`), one section per group, the `basic` entries shown and the `advanced` ones behind "Advanced". A field left
 * empty is not sent; the server checks what is sent with the reader that `--settings` uses, and writes it to the settings file of the run.
 */

export interface ParameterView {
  key: string;
  group: string;
  kind: "boolean" | "integer" | "number" | "list" | "text" | "text-or-number" | "choice" | "json";
  choices?: string[];
  type: string;
  default: string;
  summary: string;
  status: "stable" | "beta" | "experimental" | "internal";
  ui: "basic" | "advanced";
  solveFlag?: string;
  /** What `solve` runs with when it is not the default of `harness run` (`default`), and the set that gives it. */
  solveDefault?: string;
  solveSet?: string;
}

interface ParameterList {
  groups: Array<{ id: string; summary: string }>;
  parameters: ParameterView[];
}

/** What the person typed, as the values a settings file holds: the filled-in fields only, or what is wrong with one of them. */
export function collectSettings(parameters: readonly ParameterView[], raw: Readonly<Record<string, string>>): { settings: Record<string, unknown>; error?: string } {
  const settings: Record<string, unknown> = {};
  for (const p of parameters) {
    const text = (raw[p.key] ?? "").trim();
    if (text === "") continue;
    switch (p.kind) {
      case "boolean":
        settings[p.key] = text === "true";
        break;
      case "integer":
      case "number": {
        const n = Number(text);
        if (!Number.isFinite(n)) return { settings, error: `${p.key} must be a number` };
        settings[p.key] = n;
        break;
      }
      case "list":
        settings[p.key] = text.split(",").map((x) => x.trim()).filter((x) => x !== "");
        break;
      case "json":
        try {
          settings[p.key] = JSON.parse(text) as unknown;
        } catch {
          return { settings, error: `${p.key} must be JSON, as in ${p.type}` };
        }
        break;
      default:
        settings[p.key] = text;
    }
  }
  return { settings };
}

function Field(props: { p: ParameterView; value: string; set: (value: string) => void }) {
  const { p, value, set } = props;
  const id = `setting-${p.key}`;
  const shownDefault = p.solveDefault ?? p.default;
  const mark = p.solveDefault === undefined ? "" : p.solveDefault === "true" ? `on in ${p.solveSet}` : `${p.solveSet} default`;
  const on = (e: Event) => set((e.target as HTMLInputElement).value);
  return (
    <div class="setting">
      <label for={id}>
        <code>{p.key}</code>
        {p.status === "beta" || p.status === "experimental" ? <span class={`chip badge ${p.status}`}> {p.status}</span> : null}
        {mark !== "" ? <span class="chip badge solve-default"> {mark}</span> : null}
      </label>
      {p.kind === "boolean" || p.kind === "choice" ? (
        <select id={id} value={value} onChange={on} aria-describedby={`${id}-help`}>
          <option value="">Default ({shownDefault})</option>
          {p.kind === "boolean" ? (
            <>
              <option value="true">On</option>
              <option value="false">Off</option>
            </>
          ) : (
            (p.choices ?? []).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))
          )}
        </select>
      ) : p.kind === "json" ? (
        <textarea id={id} class="short" value={value} onInput={on} placeholder={shownDefault} spellcheck={false} aria-describedby={`${id}-help`} />
      ) : (
        <input id={id} type={p.kind === "integer" || p.kind === "number" ? "number" : "text"} step={p.kind === "integer" ? "1" : "any"} value={value} onInput={on} placeholder={shownDefault} spellcheck={false} aria-describedby={`${id}-help`} />
      )}
      <p class="muted small" id={`${id}-help`}>
        {p.summary} {p.kind === "json" ? `JSON: ${p.type}.` : p.kind === "list" ? "Separate the items with commas." : ""}
      </p>
    </div>
  );
}

/** `command` is the command the form starts: `solve` leaves out the settings its own fields and flags take. */
export function SettingsPanel(props: { command: "solve" | "run"; defaults?: "v1" | "v2"; onChange: (settings: Record<string, unknown> | undefined, error: string | undefined) => void }) {
  const [list, setList] = useState<ParameterList | undefined>();
  const [failed, setFailed] = useState<string | undefined>();
  const [raw, setRaw] = useState<Record<string, string>>({});

  useEffect(() => {
    get<ParameterList>(props.command === "solve" ? `/api/parameters?command=solve&defaults=${props.defaults ?? "v2"}` : "/api/parameters").then(setList, (e) => setFailed(message(e)));
  }, [props.command, props.defaults]);

  const shown = (list?.parameters ?? []).filter((p) => props.command === "run" || p.solveFlag === undefined);
  const { onChange } = props;
  useEffect(() => {
    const { settings, error } = collectSettings(shown, raw);
    onChange(Object.keys(settings).length > 0 ? settings : undefined, error);
    // `shown` follows `list`, which is the only thing besides the fields that changes it.
  }, [raw, list]);

  if (failed !== undefined) return <Notice kind="warn">The settings could not be loaded: {failed}</Notice>;
  if (list === undefined) return <p class="muted">Loading the settings...</p>;
  return (
    <section class="settings" aria-label="Settings">
      <h2>Settings</h2>
      <p class="muted">Every setting of a run, from the harness's own list. A field left empty is not sent: the run uses its default, shown in the field.</p>
      {list.groups.map((g) => {
        const here = shown.filter((p) => p.group === g.id);
        const basic = here.filter((p) => p.ui === "basic");
        const advanced = here.filter((p) => p.ui === "advanced");
        if (here.length === 0) return null;
        const field = (p: ParameterView) => <Field key={p.key} p={p} value={raw[p.key] ?? ""} set={(value) => setRaw((r) => ({ ...r, [p.key]: value }))} />;
        return (
          <fieldset key={g.id} class="group" data-group={g.id}>
            <legend>{g.id}</legend>
            <p class="muted small">{g.summary}</p>
            {basic.map(field)}
            {advanced.length > 0 ? (
              <details>
                <summary>Advanced ({advanced.length})</summary>
                {advanced.map(field)}
              </details>
            ) : null}
          </fieldset>
        );
      })}
    </section>
  );
}
