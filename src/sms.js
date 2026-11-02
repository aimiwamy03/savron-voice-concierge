// Texts through Twilio. Without credentials nothing is sent, and every message
// is kept in the outbox so the demo page can show what would have gone out.
function e164(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (String(phone || '').startsWith('+')) return `+${d}`;
  return d.length === 10 ? `+1${d}` : null;
}

function createSms(env = process.env, { fetchImpl = fetch, log = console.log } = {}) {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM: from, SHOP_NOTIFY_PHONE: shopPhone } = env;
  const live = !!(sid && token && from);
  let barberPhones = {};
  try { barberPhones = env.BARBER_PHONES ? JSON.parse(env.BARBER_PHONES) : {}; } catch { log('BARBER_PHONES is not valid JSON, ignoring it'); }
  const outbox = [];

  function send({ to, body, kind }) {
    const number = e164(to);
    const entry = { at: new Date().toISOString(), kind, to: number, body, status: !number ? 'no_recipient' : live ? 'sending' : 'not_sent_no_twilio' };
    outbox.push(entry);
    if (!number || !live) return entry;
    // The caller shouldn't wait on the text, so the result lands in the outbox.
    fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: number, From: from, Body: body }),
    }).then(async (res) => {
      entry.status = res.ok ? 'sent' : `failed_${res.status}`;
      if (!res.ok) log(`Twilio SMS failed: ${res.status} ${await res.text()}`);
    }).catch((e) => { entry.status = 'failed'; log(`Twilio SMS failed: ${e.message}`); });
    return entry;
  }

  return {
    live,
    outbox,
    send,
    notifyShop: (body) => send({ to: shopPhone, body, kind: 'shop' }),
    // No number for this barber means the shop gets it, so a request is never lost.
    notifyBarber(name, body) {
      const phone = barberPhones[name];
      return phone ? send({ to: phone, body, kind: 'barber' }) : send({ to: shopPhone, body: `For ${name}: ${body}`, kind: 'shop' });
    },
  };
}

module.exports = { createSms, e164 };
