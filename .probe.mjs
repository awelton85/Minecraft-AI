import { makeBot, describeState, mc } from './test/skills.smoke.mjs';
const { bot } = await makeBot('SkillTestP');
console.log('version', bot.version);
console.log(describeState(bot,{detail:'brief'}));
console.log(describeState(bot,{detail:'full'}));
const rs = bot.recipesAll(bot.registry.itemsByName.wooden_pickaxe.id, null, true);
console.log(rs.length, JSON.stringify(rs[0]), JSON.stringify(rs[1]));
const st = bot.recipesAll(bot.registry.itemsByName.stick.id, null, false);
console.log(st.length, JSON.stringify(st[0]));
const bp = bot.recipesAll(bot.registry.itemsByName.oak_planks.id, null, false);
console.log(bp.length, JSON.stringify(bp[0]));
console.log(bot.blockAt(bot.entity.position.floored()).getProperties?.());
bot.quit(); process.exit(0)
