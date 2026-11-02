// Pull a shop's sources right now and print what the agent would know.
//   npm run live
//   npm run live -- other            (shops/other.json)
//   npm run live -- other --prompt
const { pullShop } = require('../src/live/shopinfo');
const { loadShopConfig, defaultShopId } = require('../server');
const { buildPrompt, shopData, unknowns } = require('../src/prompt');
const { localParts } = require('../src/time');

(async () => {
  const args = process.argv.slice(2);
  const config = loadShopConfig(args.find((a) => !a.startsWith('--')) || defaultShopId());
  const shop = await pullShop(config);
  for (const s of shop.sources) console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${s.label}${s.ok ? '' : ` (${s.error})`}`);
  if (args.includes('--prompt')) return console.log(`\n${buildPrompt(shop, localParts(new Date(), shop.timezone))}`);
  console.log(`\n${JSON.stringify(shopData(shop), null, 2)}`);
  console.log(`\nConflicts: ${JSON.stringify(shop.conflicts.map((c) => [c.fact, c.kept.value, c.other.value]))}`);
  console.log(`\nAgent will say the team follows up on: ${unknowns(shop).join('; ')}`);
  return undefined;
})().catch((e) => { console.error(e); process.exit(1); });
