// Checks our Settings message against Deepgram's published AsyncAPI spec, using
// a live pull of the shop so the real prompt and tools are what gets validated.
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const Ajv = require('ajv');
const { pullShop } = require('../src/live/shopinfo');
const { loadShopConfig, defaultShopId } = require('../server');
const { buildSettings } = require('../src/settings');
const { localParts } = require('../src/time');

(async () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'spec', 'voice-agent-asyncapi.md'), 'utf8');
  const doc = yaml.load(md.match(/```yaml\n([\s\S]*?)```/)[1]);
  const ajv = new Ajv({ strict: false, allErrors: true });
  ajv.addFormat('double', true); ajv.addFormat('binary', true); ajv.addFormat('uuid', /^[0-9a-f-]{36}$/i);
  ajv.addSchema({ $id: 'dg', components: doc.components }, 'dg');
  const validate = ajv.getSchema('dg#/components/schemas/AgentV1_AgentV1Settings');
  const shop = await pullShop(loadShopConfig(defaultShopId()));
  let failed = 0;
  for (const channel of ['browser', 'phone']) {
    const s = buildSettings({ shop, channel, now: localParts(new Date(), shop.timezone) });
    const ok = validate(s);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${channel} settings (prompt ${s.agent.think.prompt.length} chars, ${s.agent.think.functions.length} tools)`);
    if (!ok) { failed++; console.log(JSON.stringify(validate.errors, null, 2)); }
  }
  process.exit(failed ? 1 : 0);
})();
