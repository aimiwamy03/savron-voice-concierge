const test = require('node:test');
const assert = require('node:assert');
const p = require('../src/live/parse');

test('pageText drops scripts and keeps inline text on one line', () => {
  const t = p.pageText('<head><title>x</title></head><script>no()</script><p>Book at <a href="/b">the &amp; site</a> now</p><div>Next</div>');
  assert.strictEqual(t, 'Book at the & site now\nNext');
});

test('businessFacts reads schema.org data, and only the business block', () => {
  const html = '<script type="application/ld+json">{"@type":"BreadcrumbList","name":"No"}</script><script type="application/ld+json">{"@type":"HairSalon","name":"Shop","email":"a@b.c","address":{"streetAddress":"1 Main","addressLocality":"Town","addressRegion":"MN","postalCode":"55555"},"aggregateRating":{"ratingValue":4.5,"reviewCount":9},"openingHoursSpecification":[{"dayOfWeek":["Monday"],"opens":"09:00:00","closes":"17:00:00"}]}</script>';
  const f = p.businessFacts(html);
  assert.strictEqual(f.name, 'Shop');
  assert.strictEqual(f.address, '1 Main, Town, MN 55555');
  assert.strictEqual(f.rating, 4.5);
  assert.deepStrictEqual(f.shop_hours, { mon: ['09:00', '17:00'] });
});

test('menuItems takes the two lines before each marker and skips counters', () => {
  const t = 'Intro\nThe Menu\nHeading\n0\n1\nCut One\nA cut.\nBook\n0\n2\nCut Two\nAnother.\nBook\nEnd';
  assert.deepStrictEqual(p.menuItems(t, { start: 'The Menu', end: 'End', item_end: 'Book' }), [{ name: 'Cut One', description: 'A cut.' }, { name: 'Cut Two', description: 'Another.' }]);
});

test('pricedItems reads each menu heading', () => {
  const re = '^\\s*\\d+\\.\\s+(.+?)(?:\\s+·\\s+|\\.\\s+)(.*?)\\s*\\(\\$(\\d+)\\s*·\\s*(\\d+)\\s*min\\)';
  const items = p.pricedItems('1. Cut · sharp ($40 · 30 min)\ntext\n2. Cut + Beard. Jaw work ($70 · 60 min)', re);
  assert.deepStrictEqual(items.map((i) => [i.name, i.price_usd, i.duration_min]), [['Cut', 40, 30], ['Cut + Beard', 70, 60]]);
});

test('booksyPage rebuilds the indexed page data', () => {
  const data = [
    ['ShallowReactive', 1],
    { serviceCategories: 2, staff: 3, name: 4, openHours: 5, depositPolicy: 6, amenities: 7 },
    [8], [9], 'Listing', [10], 'Fee may apply.\nMore text.', [11],
    { services: 12 }, { id: 13, name: 14 }, { dayOfWeek: 15, openFrom: 16, openTill: 17 }, { label: 18 },
    [19], 77, 'Jo Barber', 2, '10:00', '18:00', 'Credit cards accepted',
    { name: 20, description: 21, stafferId: 22, variants: 23 }, 'Fade', 'A fade', [13], [24],
    { price: 25, servicePrice: 26, duration: 27, promotion: 21 }, 30, '$30.00+', 45,
  ];
  const html = `<script id="__NUXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;
  const out = p.booksyPage(html);
  assert.strictEqual(out.listing_name, 'Listing');
  assert.deepStrictEqual(out.staff, [{ id: 77, name: 'Jo Barber' }]);
  assert.deepStrictEqual(out.hours, { tue: ['10:00', '18:00'] });
  assert.strictEqual(out.cancellation_policy, 'Fee may apply.');
  assert.strictEqual(out.services[0].price_usd, 30);
  assert.strictEqual(out.services[0].price_is_starting, true);
  assert.strictEqual(out.services[0].duration_min, 45);
});

test('booksyPage says so when the layout changes', () => {
  assert.throws(() => p.booksyPage('<html></html>'), /not recognized/);
});
