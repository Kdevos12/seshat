import { SKILL_FULL_LIMIT, type PackSkill } from "./packs.ts";

/**
 * The skills of installed packs under Global Constraint 16: at most `SKILL_FULL_LIMIT` are loaded in
 * full in a session, and the others are listed by name and description. Skills are written by people.
 * Nothing here writes one, and nothing turns a run's outcomes into one.
 */
export interface SkillOptions {
  /** The skills to load in full, by name. Default: none, every skill is listed. */
  full?: readonly string[];
  /** How many may be loaded in full: 0 to 3. Default 3. */
  maxFull?: number;
}

export interface SkillSelection {
  full: PackSkill[];
  listed: PackSkill[];
}

export class SkillLimitError extends Error {}

export function selectSkills(skills: readonly PackSkill[], options: SkillOptions = {}): SkillSelection {
  const maxFull = options.maxFull ?? SKILL_FULL_LIMIT;
  if (!Number.isInteger(maxFull) || maxFull < 0 || maxFull > SKILL_FULL_LIMIT) {
    throw new SkillLimitError(`maxFull is ${maxFull}: at most ${SKILL_FULL_LIMIT} skills are loaded in full in a session`);
  }
  const wanted = [...new Set(options.full ?? [])];
  if (wanted.length > maxFull) {
    throw new SkillLimitError(`${wanted.length} skills asked in full (${wanted.join(", ")}): at most ${maxFull} are loaded in full, the others are listed by name and description`);
  }
  const byName = new Map<string, PackSkill>();
  for (const skill of skills) byName.set(skill.name, skill);
  if (byName.size !== skills.length) throw new SkillLimitError("two skills have the same name");
  for (const name of wanted) if (!byName.has(name)) throw new SkillLimitError(`no installed skill ${name}`);
  return {
    full: wanted.map((name) => byName.get(name) as PackSkill),
    listed: skills.filter((s) => !wanted.includes(s.name)),
  };
}

/**
 * The selection as text for a model. Each skill says which pack and which version of its text it comes
 * from: it is advice from outside the run, never a lesson and never part of a system prompt.
 */
export function renderSkills(selection: SkillSelection): string {
  const parts: string[] = [];
  for (const skill of selection.full) parts.push(`## Skill ${skill.name} (pack ${skill.pack})\n${skill.description}\n\n${skill.text.trimEnd()}`);
  if (selection.listed.length > 0) {
    parts.push(`## Other skills (ask for one by name)\n${selection.listed.map((s) => `- ${s.name} (pack ${s.pack}): ${s.description}`).join("\n")}`);
  }
  return parts.join("\n\n");
}
