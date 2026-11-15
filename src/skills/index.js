// Skill registry. Contract: see docs/ARCHITECTURE.md ("Skill contract").
import { SkillError, stopEverything, closeOpenWindow, haltPathfinder } from './util.js';
import { movementSkills } from './movement.js';
import { gatherSkills } from './gather.js';
import { craftSkills } from './craft.js';
import { buildSkills } from './build.js';
import { inventorySkills } from './inventory.js';
import { combatSkills } from './combat.js';
import { miscSkills } from './misc.js';
import { memorySkills } from './memory.js';

const MAX_RESULT = 3000; // look_around returns ~2500 chars; everything else is much shorter

const FALLBACK_BUDGET_MS = 170000;

/** Wrap a skill: normalise errors to SkillError, always release the bot's controls/pathfinder/windows, provide a deadline. */
function wrap(skill) {
  const inner = skill.run;
  return {
    ...skill,
    params: skill.params ?? { type: 'object', properties: {}, additionalProperties: false },
    async run(ctx0, args = {}) {
      // every skill gets a deadline, even when the caller (tests) does not set one
      let ctx = ctx0;
      if (!Number.isFinite(ctx0.deadline) && typeof ctx0.timeLeftMs !== 'function') {
        ctx = Object.create(ctx0, { deadline: { value: Date.now() + FALLBACK_BUDGET_MS } });
      }
      if (ctx.signal?.aborted) throw new SkillError('Aborted');
      closeOpenWindow(ctx.bot); // a window leaked by an earlier skill breaks crafting for good
      try {
        let out = await inner(ctx, args ?? {});
        out = String(out ?? 'Done.');
        closeOpenWindow(ctx.bot);
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
