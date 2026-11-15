// Skill registry. Contract: see docs/ARCHITECTURE.md ("Skill contract").
import { SkillError, stopEverything } from './util.js';
import { movementSkills } from './movement.js';
import { gatherSkills } from './gather.js';
import { craftSkills } from './craft.js';
import { buildSkills } from './build.js';
import { inventorySkills } from './inventory.js';
import { combatSkills } from './combat.js';
import { miscSkills } from './misc.js';
import { memorySkills } from './memory.js';

const MAX_RESULT = 3000; // look_around returns ~2500 chars; everything else is much shorter

/** Wrap a skill: normalise errors to SkillError, always release the bot's controls/pathfinder on failure/abort. */
function wrap(skill) {
  const inner = skill.run;
  return {
    ...skill,
    params: skill.params ?? { type: 'object', properties: {}, additionalProperties: false },
    async run(ctx, args = {}) {
      if (ctx.signal?.aborted) throw new SkillError('Aborted');
      try {
        let out = await inner(ctx, args ?? {});
        out = String(out ?? 'Done.');
        return out.length > MAX_RESULT ? out.slice(0, MAX_RESULT - 3) + '...' : out;
      } catch (err) {
        stopEverything(ctx);
        if (err instanceof SkillError) throw err;
        if (ctx.signal?.aborted) throw new SkillError('Aborted');
        const e = new SkillError(`${skill.name} failed: ${err?.message ?? err}`);
        e.cause = err;
        throw e;
      }
    },
  };
}

export const skills = [
  ...movementSkills, ...gatherSkills, ...craftSkills, ...buildSkills,
  ...inventorySkills, ...combatSkills, ...miscSkills, ...memorySkills,
].map(wrap);

const byName = new Map(skills.map((s) => [s.name, s]));
if (byName.size !== skills.length) throw new Error('Duplicate skill names in registry');

export function getSkill(name) {
  return byName.get(name);
}

export { describeState } from './observe.js';
export { SkillError };
