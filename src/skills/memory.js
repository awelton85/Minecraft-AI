// Memory skills (long-lived facts). Places live in movement.js (save_place / go_to_place / list_places).
import { SkillError, goals, moveTo, fmtPos, collectDrops, formatCounts, Vec3, outOfTime } from './util.js';

export const memorySkills = [
  {
    name: 'remember',
    description: 'Store a long-lived fact in persistent memory (survives restarts), e.g. "owner prefers oak", "iron found near 120,60,-300", "base has a chest room west of the door". Keep facts short and concrete. For locations prefer save_place.',
    params: {
      type: 'object',
      properties: { fact: { type: 'string' } },
      required: ['fact'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const fact = String(args.fact ?? '').trim();
      if (!fact) throw new SkillError('Nothing to remember.');
      const id = ctx.memory.addFact(fact);
      return `Remembered (id ${id}): ${fact.slice(0, 160)}`;
    },
  },
  {
    name: 'forget',
    description: 'Remove a remembered fact by its id or its exact text.',
    params: {
      type: 'object',
      properties: { fact: { type: 'string', description: 'the fact id or exact text' } },
      required: ['fact'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const fact = String(args.fact ?? '').trim();
      if (!fact) throw new SkillError('Say which fact to forget: its id number or its text.');
      const ok = ctx.memory.removeFact(fact);
      if (!ok) throw new SkillError(`No single remembered fact matches "${fact}". Use the fact's id number from your memory list.`);
      return `Forgot: ${args.fact}`;
    },
  },
  {
    name: 'return_to_death',
    description: 'Walk to where you last died (from memory) and pick up the dropped items there. Items despawn about 5 minutes after death, so go quickly; beware of whatever killed you.',
    params: { type: 'object', properties: {}, additionalProperties: false },
    async run(ctx) {
      const deaths = ctx.memory?.data?.deaths ?? [];
      const d = deaths.at(-1);
      if (!d) throw new SkillError('No recorded death location.');
      const dim = (ctx.bot.game?.dimension ?? 'overworld').replace('minecraft:', '');
      if (d.dimension && d.dimension.replace('minecraft:', '') !== dim) throw new SkillError(`I died in the ${d.dimension} at ${d.x}, ${d.y}, ${d.z}, but I am in the ${dim}.`);
      const ageMin = Math.round((Date.now() - (d.ts ?? Date.now())) / 60000);
      const target = new Vec3(d.x, d.y, d.z);
      try {
        await moveTo(ctx, new goals.GoalNear(d.x, d.y, d.z, 3), { label: `death spot ${d.x}, ${d.y}, ${d.z}` });
      } catch (err) {
        if (err.code === 'timeout') return `Still on the way to my death spot ${d.x}, ${d.y}, ${d.z} (now at ${fmtPos(ctx.bot.entity.position)}); call return_to_death again.`;
        throw err;
      }
      const got = await collectDrops(ctx, target, { radius: 12, maxMs: 15000 });
      const txt = Object.keys(got).length ? `Recovered ${formatCounts(got, 10)}.` : `No items found${ageMin >= 5 ? ' (they probably despawned: died ' + ageMin + ' min ago)' : ''}.`;
      return `Went to my death spot (${d.x}, ${d.y}, ${d.z}, cause: ${d.cause ?? 'unknown'}). ${txt}`;
    },
  },
];
