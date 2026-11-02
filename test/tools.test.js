const test = require('node:test');
const assert = require('node:assert');
const { createTools, createLedger } = require('../src/tools');
const { createSms } = require('../src/sms');

const shop = {
  spoken_name: 'Shop', timezone: 'America/Chicago',
  services: [{ name: 'House Cut' }, { name: 'Kids Cut' }],
  barbers: [
    { name: 'Dee Owner', role: 'owner', calendar: 'shop' },
    { name: 'Jo Barber', role: 'barber', calendar: 'booksy', external: true, hours: { sat: ['10:00', '20:00'] }, services: [{ name: 'Adult Haircut', price_usd: 40 }] },
  ],
};
// Monday Nov 2 2026, 10 AM Central.
const clock = () => new Date('2026-11-02T16:00:00Z');
function setup(env = { SHOP_NOTIFY_PHONE: '+16125550100' }, language = 'en') {
  const sms = createSms(env, { fetchImpl: async () => ({ ok: true }), log: () => {} });
  const ledger = createLedger();
  return { sms, ledger, tools: createTools({ shop, ledger, sms, clock, getLanguage: () => language }) };
}
const req = (o) => ({ service: 'House Cut', barber: 'Dee', date: '2026-11-07', time: '14:00', customer_name: 'Sam', customer_phone: '612 555 0142', ...o });

test('availability never claims an open time, and uses a barber\'s live hours', () => {
  const { tools } = setup();
  const known = tools.run('check_availability', { barber: 'Jo', date: '2026-11-07' });
  assert.strictEqual(known.live_calendar, false);
  assert.strictEqual(known.listed_hours, '10 AM to 8 PM');
  assert.strictEqual(tools.run('check_availability', { barber: 'Jo', date: '2026-11-08' }).works_that_day, false);
  assert.strictEqual(tools.run('check_availability', { barber: 'Nobody', date: '2026-11-07' }).error, 'UNKNOWN_BARBER');
  assert.strictEqual(tools.run('check_availability', { date: '2026-11-01' }).error, 'PAST_DATE');
});

test('book creates a pending request and tells the shop', () => {
  const { tools, sms } = setup();
  const r = tools.run('book', req());
  assert.strictEqual(r.status, 'awaiting_shop_confirmation');
  assert.strictEqual(sms.outbox[0].kind, 'shop');
  assert.match(sms.outbox[0].body, /House Cut with Dee Owner/);
});

test('an outside calendar barber must go through approval, and the reverse', () => {
  const { tools } = setup();
  assert.strictEqual(tools.run('book', req({ barber: 'Jo', service: 'Adult Haircut' })).error, 'USE_REQUEST_APPROVAL');
  assert.strictEqual(tools.run('request_approval', req()).error, 'USE_BOOK');
});

test('approval texts the barber, or the shop when no number is set', () => {
  const withNumber = setup({ SHOP_NOTIFY_PHONE: '+16125550100', BARBER_PHONES: '{"Jo Barber":"+16125550111"}' });
  const r = withNumber.tools.run('request_approval', req({ barber: 'Jo', service: 'Adult Haircut' }));
  assert.strictEqual(r.status, 'awaiting_barber_approval');
  assert.strictEqual(withNumber.sms.outbox[0].to, '+16125550111');
  const without = setup();
  without.tools.run('request_approval', req({ barber: 'Jo', service: 'Adult Haircut' }));
  assert.strictEqual(without.sms.outbox[0].to, '+16125550100');
  assert.match(without.sms.outbox[0].body, /^For Jo Barber:/);
});

test('a service has to exist on that barber\'s live menu', () => {
  const { tools } = setup();
  const r = tools.run('request_approval', req({ barber: 'Jo', service: 'House Cut' }));
  assert.strictEqual(r.error, 'UNKNOWN_SERVICE');
  assert.deepStrictEqual(r.available, ['Adult Haircut']);
});

test('confirmation text goes once, to the number on the request, in the caller\'s language', () => {
  const { tools, sms } = setup({ SHOP_NOTIFY_PHONE: '+16125550100' }, 'es');
  const { confirmation_code: code } = tools.run('book', req());
  assert.strictEqual(tools.run('send_confirmation', { confirmation_code: code }).ok, true);
  assert.strictEqual(tools.run('send_confirmation', { confirmation_code: code }).already_sent, true);
  const texts = sms.outbox.filter((t) => t.kind === 'confirmation');
  assert.strictEqual(texts.length, 1);
  assert.strictEqual(texts[0].to, '+16125550142');
  assert.match(texts[0].body, /solicitud/);
  assert.strictEqual(tools.run('send_confirmation', { confirmation_code: 'NOPE' }).error, 'UNKNOWN_CODE');
});

test('rescheduling a booking from elsewhere still reaches a person', () => {
  const { tools, sms } = setup();
  const r = tools.run('reschedule', { customer_phone: '6125550142', new_date: '2026-11-12', new_time: '15:00' });
  assert.strictEqual(r.found_on_this_line, false);
  assert.match(sms.outbox[0].body, /reschedule request/);
  assert.strictEqual(tools.run('cancel', {}).error, 'NEED_CODE_OR_PHONE');
});

test('without Twilio nothing is sent, and the outbox says so', () => {
  const { tools, sms } = setup();
  tools.run('notify_shop', { summary: 'Upset caller', urgent: true });
  assert.strictEqual(sms.live, false);
  assert.strictEqual(sms.outbox[0].status, 'not_sent_no_twilio');
  assert.match(sms.outbox[0].body, /^URGENT/);
});
