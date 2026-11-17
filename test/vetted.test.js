// The hand-checked data file (shops/savron.data.json) fills what live pages
// don't give, without overriding live facts.
const test = require('node:test');
const assert = require('node:assert');
const { pullShop } = require('../src/live/shopinfo');
const { shopData, unknowns } = require('../src/prompt');
const { createTools, createLedger } = require('../src/tools');
const { createSms } = require('../src/sms');
const config = require('../shops/savron.json');

const offline = async () => { throw new Error('offline'); };
const booksyKris = {
  ...config,
  sources: [
    { id: 'booksy', label: 'Booksy', type: 'booksy', url: 'https://booksy.test/kris' },
    { id: 'site', label: 'Site', type: 'page', url: 'https://site.test/', jsonld: true },
    config.sources.find((s) => s.type === 'file'),
  ],
};
const booksyHtml = '<script>window.__NUXT__=1</script>';

test('with every web source down, the agent still knows all six barbers, hours and menus', async () => {
  const s = await pullShop(config, { fetchImpl: offline });
  const d = shopData(s);
  assert.deepStrictEqual(d.barbers.map((b) => b.name), ['Albe Herrera', 'Xavior Williams', 'Johander (JM)', 'Paul G', 'Kris Edwards', 'Elle Gibeau']);
  assert.ok(d.barbers.every((b) => b.own_hours && b.own_menu.length));
  assert.match(d.shop_hours, /^Monday 9 AM to 7 PM.*Saturday 9 AM to 6 PM; Sunday 9 AM to 2 PM$/);
  assert.match(d.barbers.find((b) => b.name === 'Paul G').own_hours, /Monday not listed; Tuesday not listed; Wednesday 10 AM/);
  assert.ok(d.shop_menu.some((m) => m.name === 'Beard Sculpting' && m.price_usd === 45));
  const elle = d.barbers.find((b) => b.name === 'Elle Gibeau');
  assert.ok(elle.own_menu.some((m) => m.name === 'Grey Blending' && m.price_usd === 50));
  assert.ok(elle.own_menu.some((m) => /Wax/.test(m.name) && m.price_usd === 85));
  assert.match(d.happy_hour, /10 dollars off/);
  assert.strictEqual(d.owner, 'Albe Herrera');
  assert.strictEqual(d.membership.access, 'Invitation only');
  const u = unknowns(s);
  assert.ok(!u.includes('the full list of barbers and their days'));
  assert.ok(!u.includes('the hours of the shop as a whole'));
  assert.ok(!u.includes('shop menu prices'));
});

test('a live fact wins over the file; the file only fills gaps', async () => {
  const fetchImpl = async (u) => ({ ok: true, status: 200, text: async () => (u.startsWith('https://site') ? '<script type="application/ld+json">{"@type":"BarberShop","name":"SAVRON Barbershop & Lounge","email":"new@savronmn.com"}</script>' : '') });
  const s = await pullShop({ ...config, sources: [booksyKris.sources[1], booksyKris.sources[2]] }, { fetchImpl });
  assert.strictEqual(s.facts.email.value, 'new@savronmn.com');
  assert.strictEqual(s.facts.email.source, 'site');
  assert.strictEqual(s.facts.owner.source, 'vetted');
});

test('a Booksy listing for "Kris" merges into Kris Edwards and keeps its external calendar', async () => {
  const parse = require('../src/live/parse');
  const real = parse.booksyPage;
  parse.booksyPage = () => ({ listing_name: 'Krisbladez@Savron', hours: { tue: ['10:00', '20:00'] }, cancellation_policy: null, amenities: [], services: [{ name: 'Fade', price_usd: 45, staff_ids: [] }], staff: [{ id: 1, name: 'Kris' }] });
  try {
    const s = await pullShop(booksyKris, { fetchImpl: async () => ({ ok: true, status: 200, text: async () => booksyHtml }) });
    const kris = s.barbers.filter((b) => /kris/i.test(b.name));
    assert.strictEqual(kris.length, 1);
    assert.strictEqual(kris[0].name, 'Kris Edwards');
    assert.strictEqual(kris[0].external, true);
    assert.deepStrictEqual(kris[0].hours.tue, ['09:00', '19:00']);
    assert.deepStrictEqual(kris[0].listing_hours, { tue: ['10:00', '20:00'] });
    assert.ok(kris[0].services.some((x) => x.name === 'Haircut and Beard Trim'));
    assert.ok(kris[0].aliases.includes('Kris'));
  } finally { parse.booksyPage = real; }
});

test('callers can ask for JM by nickname, and Paul shows as off on Monday', async () => {
  const shop = await pullShop(config, { fetchImpl: offline });
  const sms = createSms({}, { fetchImpl: async () => ({ ok: true }), log: () => {} });
  const tools = createTools({ shop, ledger: createLedger(), sms, clock: () => new Date('2026-11-16T16:00:00Z') });
  const jm = tools.run('check_availability', { barber: 'JM', date: '2026-11-21' });
  assert.strictEqual(jm.works_that_day, true);
  assert.strictEqual(jm.listed_hours, '9 AM to 4:30 PM');
  const paul = tools.run('check_availability', { barber: 'Paul', date: '2026-11-23' });
  assert.strictEqual(paul.works_that_day, false);
});
