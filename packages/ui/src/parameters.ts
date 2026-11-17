import { GROUP_SUMMARY, PARAMETER_GROUPS, RUN_PARAMETERS, settingKind, settingsFileKeys, SOLVE_OWN_FLAGS, type ParameterStatus, type ParameterUi, type RunConfig, type SettingKind } from "@seshat/orchestrator";

/**
 * The catalogue the settings menu is drawn from (`GET /api/parameters`): the entries of `packages/orchestrator/src/parameters.ts` that a person sees
 * (`ui` is not `hidden`, `status` is not `internal`: the keys a settings file accepts), with their group, type, default, summary and status. Nothing
 * here names a key: a key added to `RunConfig` and the catalogue is in the list the day it is added.
 */

export interface ParameterView {
  key: string;
  group: string;
  /** How the form enters it: a switch, a number, a list, a choice, text, or JSON for an object. */
  kind: SettingKind;
  choices?: string[];
  /** The catalogue's type, in a few words, for the person who wants the exact shape. */
  type: string;
  default: string;
  summary: string;
  status: ParameterStatus;
  ui: Exclude<ParameterUi, "hidden">;
  /** The flag of `harness solve` that takes this key's place: a form that starts a `solve` leaves the key out. */
  solveFlag?: string;
}

export interface ParameterList {
  groups: Array<{ id: string; summary: string }>;
  parameters: ParameterView[];
}

export function parameterList(): ParameterList {
  const parameters = settingsFileKeys().map((key): ParameterView => {
    const info = RUN_PARAMETERS[key as keyof RunConfig];
    const { kind, choices } = settingKind(info.type);
    const solveFlag = SOLVE_OWN_FLAGS[key as keyof RunConfig];
    return {
      key,
      group: info.group,
      kind,
      ...(choices !== undefined ? { choices } : {}),
      type: info.type,
      default: info.default,
      summary: info.summary,
      status: info.status,
      ui: info.ui as "basic" | "advanced",
      ...(solveFlag !== undefined ? { solveFlag } : {}),
    };
  });
  return { groups: PARAMETER_GROUPS.filter((g) => parameters.some((p) => p.group === g)).map((id) => ({ id, summary: GROUP_SUMMARY[id] })), parameters };
}
