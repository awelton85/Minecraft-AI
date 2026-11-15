// Memory skills (long-lived facts). Places live in movement.js (save_place / go_to_place / list_places).
import { SkillError } from './util.js';

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
      const ok = ctx.memory.removeFact(String(args.fact ?? '').trim());
      if (!ok) throw new SkillError(`No remembered fact matches "${args.fact}".`);
      return `Forgot: ${args.fact}`;
    },
  },
];
