// Tools the agent can call, and the handlers behind them. Handlers read the
// live snapshot for this call and never throw for bad input.
//
// No shop has a calendar API wired in yet, so a booking is a pending request
// that a person approves. To add one, implement checkAvailability and write
// methods for that calendar and call them from check_availability and book.
const { localParts, weekdayOf, spoken, isDate, isTime } = require('./time');

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const digits = (s) => String(s || '').replace(/\D/g, '');
function normPhone(p) {
  let d = digits(p);
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length === 10 ? d : null;
}

const REQUEST = {
  service: { type: 'string', description: 'Exact service name from SHOP DATA.' },
  barber: { type: 'string', description: 'Barber name, or "first available".' },
  date: { type: 'string', description: 'YYYY-MM-DD, from the CALENDAR list.' },
  time: { type: 'string', description: 'Preferred start, 24 hour HH:MM.' },
  customer_name: { type: 'string' },
  customer_phone: { type: 'string', description: 'Mobile number, digits only.' },
};
const REQUIRED = ['service', 'barber', 'date', 'time', 'customer_name', 'customer_phone'];

const definitions = [
  {
    name: 'check_availability',
    description: 'Find out what can be said about a barber on a date. Call before talking about times. Never invent times.',
    parameters: { type: 'object', properties: { barber: REQUEST.barber, service: REQUEST.service, date: REQUEST.date }, required: ['date'] },
  },
  {
    name: 'book',
    description: 'Send a booking request for a barber on the shop calendar, or first available. Only after the read back and a clear yes.',
    defer_until_eot: true,
    parameters: { type: 'object', properties: REQUEST, required: REQUIRED },
  },
  {
    name: 'request_approval',
    description: 'For a barber marked EXTERNAL_CALENDAR: text the barber to approve the request. Only after the read back and a clear yes.',
    defer_until_eot: true,
    parameters: { type: 'object', properties: REQUEST, required: REQUIRED },
  },
  {
    name: 'reschedule',
    description: 'Ask the shop to move an appointment. Pass the confirmation code or the mobile number on the booking. Only after a clear yes.',
    defer_until_eot: true,
    parameters: {
      type: 'object',
      properties: {
        confirmation_code: { type: 'string' },
        customer_phone: REQUEST.customer_phone,
        customer_name: REQUEST.customer_name,
        new_date: REQUEST.date,
        new_time: REQUEST.time,
      },
      required: ['new_date', 'new_time'],
    },
  },
  {
    name: 'cancel',
    description: 'Ask the shop to cancel an appointment. Pass the confirmation code or the mobile number on the booking. Only after a clear yes.',
    defer_until_eot: true,
    parameters: { type: 'object', properties: { confirmation_code: { type: 'string' }, customer_phone: REQUEST.customer_phone, customer_name: REQUEST.customer_name } },
  },
  {
    name: 'send_confirmation',
    description: 'Text the caller that their request was received. Pass the code returned by book, request_approval, reschedule, or cancel.',
    parameters: { type: 'object', properties: { confirmation_code: { type: 'string' } }, required: ['confirmation_code'] },
  },
  {
    name: 'notify_shop',
    description: 'Send the team a summary when you cannot answer something or the caller needs a person.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One or two sentences for the team.' },
        caller_name: { type: 'string' },
        callback_phone: { type: 'string', description: 'Digits only, if the caller wants a callback.' },
        urgent: { type: 'boolean', description: 'True for complaints or an upset caller.' },
      },
      required: ['summary'],
    },
  },
  {
    name: 'set_language',
    description: 'Change the voice when the caller changes language.',
    parameters: { type: 'object', properties: { language: { type: 'string', enum: ['en', 'es'] } }, required: ['language'] },
  },
  { name: 'end_call', description: 'Hang up after the goodbye.', parameters: { type: 'object', properties: {} } },
];

const CONFIRM_TEXT = {
  en: (r) => `${r.shop}: we got your request for ${r.what}. This is not final yet. The team will text you to confirm. Ref ${r.code}.`,
  es: (r) => `${r.shop}: recibimos su solicitud de ${r.what}. Aún no está confirmada. El equipo le enviará un mensaje para confirmar. Ref ${r.code}.`,
};

function createTools({ shop, ledger, sms, clock = () => new Date(), getLanguage = () => 'en' }) {
  const today = () => localParts(clock(), shop.timezone);

  const findBarber = (name) => {
    const n = norm(name);
    if (!n) return null;
    return shop.barbers.find((b) => norm(b.name) === n || norm(b.name).split(' ')[0] === n.split(' ')[0]) || null;
  };
  const isFirstAvailable = (name) => /first|any|cualquier|primero|primer/.test(norm(name));

  const findService = (barber, name) => {
    const list = barber && barber.services && barber.services.length ? barber.services : shop.services;
    const n = norm(name);
    return list.find((s) => norm(s.name) === n) || list.find((s) => norm(s.name).includes(n) || n.includes(norm(s.name))) || null;
  };
  const serviceNames = (barber) => (barber && barber.services && barber.services.length ? barber.services : shop.services).map((s) => s.name);

  const dateProblem = (date) => {
    if (!isDate(date)) return { ok: false, error: 'BAD_DATE', say: 'Use a date from the CALENDAR list as YYYY-MM-DD.' };
    if (date < today().date) return { ok: false, error: 'PAST_DATE', say: 'That day has passed. Ask for another day.' };
    return null;
  };

  const handlers = {
    check_availability({ barber, date }) {
      const bad = dateProblem(date);
      if (bad) return bad;
      const b = barber && !isFirstAvailable(barber) ? findBarber(barber) : null;
      if (barber && !isFirstAvailable(barber) && !b) return { ok: false, error: 'UNKNOWN_BARBER', known_barbers: shop.barbers.map((x) => x.name), say: 'That name is not on the list you have. Offer the barbers you know of, or say the team will follow up.' };
      if (b && b.hours) {
        const h = b.hours[weekdayOf(date)];
        if (!h) return { ok: true, live_calendar: false, works_that_day: false, say: `${b.name}'s listing shows no hours that day. Ask for another day.` };
        return { ok: true, live_calendar: false, works_that_day: true, listed_hours: `${spoken(h[0])} to ${spoken(h[1])}`, say: `Open times are not visible. Ask for a preferred time inside ${b.name}'s listed hours and send it as a request.` };
      }
      return { ok: true, live_calendar: false, say: 'Open times are not visible. Ask for a preferred time and send it as a request. The team will confirm by text.' };
    },

    book: (args) => placeRequest(args, 'book'),
    request_approval: (args) => placeRequest(args, 'request_approval'),

    reschedule(args) {
      if (!isTime(args.new_time)) return { ok: false, error: 'BAD_TIME', say: 'Use 24 hour HH:MM.' };
      const bad = dateProblem(args.new_date);
      if (bad) return bad;
      return changeRequest(args, 'reschedule', `move to ${args.new_date} ${args.new_time}`);
    },
    cancel: (args) => changeRequest(args, 'cancel', 'cancel'),

    send_confirmation({ confirmation_code: code }) {
      const r = ledger.get(code);
      if (!r) return { ok: false, error: 'UNKNOWN_CODE', say: 'Use the code you got back from the request.' };
      if (!r.customer_phone) return { ok: false, error: 'NO_NUMBER', say: 'Ask for a mobile number first.' };
      if (r.confirmation_sent) return { ok: true, already_sent: true };
      const lang = CONFIRM_TEXT[r.language] ? r.language : 'en';
      sms.send({ to: r.customer_phone, body: CONFIRM_TEXT[lang]({ shop: shop.spoken_name, what: r.what, code: r.code }), kind: 'confirmation' });
      r.confirmation_sent = true;
      return { ok: true, say: 'Tell the caller a text is on the way.' };
    },

    notify_shop({ summary, caller_name, callback_phone, urgent }) {
      if (!summary) return { ok: false, error: 'NO_SUMMARY' };
      const phone = callback_phone ? normPhone(callback_phone) : null;
      if (callback_phone && !phone) return { ok: false, error: 'BAD_PHONE', say: 'Ask for the full ten digit number.' };
      const body = `${urgent ? 'URGENT ' : ''}${shop.spoken_name} call: ${summary}${caller_name ? ` From ${caller_name}.` : ''}${phone ? ` Call back ${phone}.` : ''}`;
      sms.notifyShop(body);
      ledger.note({ type: 'handoff', summary, caller_name, callback_phone: phone, urgent: !!urgent });
      return { ok: true, say: 'Tell the caller the team will follow up.' };
    },

    set_language: ({ language }) => (['en', 'es'].includes(language) ? { ok: true, language } : { ok: false, error: 'UNSUPPORTED_LANGUAGE' }),
    end_call: () => ({ ok: true }),
  };

  function placeRequest(args, tool) {
    const bad = dateProblem(args.date);
    if (bad) return bad;
    if (!isTime(args.time)) return { ok: false, error: 'BAD_TIME', say: 'Use 24 hour HH:MM.' };
    const phone = normPhone(args.customer_phone);
    if (!phone) return { ok: false, error: 'BAD_PHONE', say: 'Ask for the full ten digit mobile number.' };
    if (!args.customer_name) return { ok: false, error: 'NO_NAME', say: 'Ask for a name.' };

    const anyone = isFirstAvailable(args.barber);
    const barber = anyone ? null : findBarber(args.barber);
    if (!anyone && !barber) return { ok: false, error: 'UNKNOWN_BARBER', known_barbers: shop.barbers.map((b) => b.name), say: 'That name is not on your list.' };
    if (barber && barber.external && tool === 'book') return { ok: false, error: 'USE_REQUEST_APPROVAL', say: `${barber.name} is on an outside calendar. Call request_approval with the same details.` };
    if (tool === 'request_approval' && (!barber || !barber.external)) return { ok: false, error: 'USE_BOOK', say: 'Call book with the same details.' };

    const service = findService(barber, args.service);
    if (!service) return { ok: false, error: 'UNKNOWN_SERVICE', available: serviceNames(barber), say: 'Offer one of the available services for this barber.' };

    const what = `${service.name}${barber ? ` with ${barber.name}` : ''} on ${args.date} around ${spoken(args.time)}`;
    const r = ledger.create({
      type: 'booking', status: barber && barber.external ? 'awaiting_barber_approval' : 'awaiting_shop_confirmation',
      service: service.name, barber: barber ? barber.name : 'first available', date: args.date, time: args.time,
      customer_name: args.customer_name, customer_phone: phone, what, language: getLanguage(),
    });
    const detail = `${args.customer_name} (${phone}) asks for ${what}. Ref ${r.code}.`;
    if (barber && barber.external) sms.notifyBarber(barber.name, `${shop.spoken_name} request: ${detail} Booked outside this line, so please add it to your calendar and text them to confirm.`);
    else sms.notifyShop(`${shop.spoken_name} booking request: ${detail} Please add it to the calendar and text them to confirm.`);
    return { ok: true, status: r.status, confirmation_code: r.code, say: 'Tell the caller this is a request and the shop will confirm by text. Then call send_confirmation.' };
  }

  function changeRequest(args, type, change) {
    const phone = args.customer_phone ? normPhone(args.customer_phone) : null;
    if (!args.confirmation_code && !phone) return { ok: false, error: 'NEED_CODE_OR_PHONE', say: 'Ask for the confirmation code or the mobile number on the booking.' };
    // A booking made outside this line is not in the ledger, so the request still goes to a person.
    const original = args.confirmation_code ? ledger.get(args.confirmation_code) : phone ? ledger.latestForPhone(phone) : null;
    const target = phone || (original && original.customer_phone);
    const what = `${change === 'cancel' ? 'cancelling' : change} ${original ? original.what : 'an existing appointment'}`;
    const r = ledger.create({ type, status: 'awaiting_shop_confirmation', of: original ? original.code : null, customer_name: args.customer_name || (original && original.customer_name) || null, customer_phone: target, what, language: getLanguage() });
    const body = `${shop.spoken_name} ${type} request: ${r.customer_name || 'Caller'} (${target || 'no number on file, code only'}): ${what}. Ref ${r.code}.`;
    if (original && original.status === 'awaiting_barber_approval') sms.notifyBarber(original.barber, body);
    else sms.notifyShop(body);
    return { ok: true, status: r.status, confirmation_code: r.code, found_on_this_line: !!original, say: 'Tell the caller the request is in and the team will confirm by text. Then call send_confirmation.' };
  }

  return {
    definitions,
    run(name, rawArgs) {
      const h = handlers[name];
      if (!h) return { ok: false, error: 'UNKNOWN_TOOL' };
      let args = rawArgs;
      if (typeof rawArgs === 'string') { try { args = rawArgs ? JSON.parse(rawArgs) : {}; } catch { return { ok: false, error: 'BAD_ARGUMENTS' }; } }
      return h(args || {});
    },
  };
}

// In memory for the demo: a restart clears it.
function createLedger() {
  const items = new Map();
  const notes = [];
  let seq = 1000;
  const get = (code) => items.get(String(code || '').toUpperCase().replace(/\s/g, '')) || null;
  return {
    create(fields) {
      const code = `SV${++seq}`;
      const r = { code, created_at: new Date().toISOString(), ...fields };
      items.set(code, r);
      return r;
    },
    get,
    latestForPhone: (phone) => [...items.values()].reverse().find((r) => r.type === 'booking' && r.customer_phone === phone) || null,
    note: (n) => notes.push({ at: new Date().toISOString(), ...n }),
    list: () => ({ requests: [...items.values()], handoffs: notes }),
  };
}

module.exports = { definitions, createTools, createLedger, normPhone };
