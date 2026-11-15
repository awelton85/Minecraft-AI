import { makeBot, makeCtx, run, mc, sleep } from './test/skills.smoke.mjs';
const { bot, mcData } = await makeBot('SkillTestP');
const ctx = makeCtx(bot, mcData);
await mc('clear SkillTestP'); await mc('give SkillTestP oak_log 8'); await sleep(1000);
await run(ctx, 'craft_item', { item: 'planks', count: 8 });
await run(ctx, 'craft_item', { item: 'stick', count: 4 });
await run(ctx, 'craft_item', { item: 'crafting_table' });
await sleep(1000);
const dump = (t) => console.log(t, bot.inventory.slots.map((s,i)=>s?`${i}:${s.name}x${s.count}`:null).filter(Boolean).join(' '), 'cursor', bot.inventory.selectedItem?.name);
dump('pre');
const ow=bot._client.write.bind(bot._client); bot._client.write=(n,p)=>{ ow(n,p); if(n==='window_click') console.log('CLICK', p.windowId, 'slot',p.slot,'btn',p.mouseButton,'mode',p.mode,'carried',p.cursorItem?.itemCount, p.cursorItem?.itemId); };
bot._client.on('set_slot', p => console.log('set_slot', p.windowId, p.slot, p.item.itemCount, p.item.itemId));
bot._client.on('close_window', p => console.log('close_window', p));
await run(ctx, 'craft_item', { item: 'wooden_pickaxe' });
await sleep(1000); dump('post');
bot.quit(); process.exit(0)
