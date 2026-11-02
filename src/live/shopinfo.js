// Pulls a shop's facts from its sources and merges them into one snapshot.
// Sources are read in config order, so for a single fact the earlier source
// wins and any disagreement is kept in `conflicts`. A source that fails never
// takes the others down. Unknown stays unknown: nothing here fills a gap.
const parse = require('./parse');

const UA = 'Mozilla/5.0 (compatible; VoiceConcierge/0.1)';
const clean = (v, max = 400) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').replace(/\s+([,.])/g, '$1').trim().slice(0, max) : v);
const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function fetchPage(url, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const res = await fetchImpl(url, { headers: { 'user-agent': UA, accept: 'text/html' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Each reader returns { facts, services, barbers } from one fetched page.
function readPage(src, html) {
  const text = parse.pageText(html);
  if (src.fail_if && new RegExp(src.fail_if, 'i').test(`${text}\n${html.slice(0, 2000)}`)) throw new Error('site returned an error page');
  const facts = src.jsonld ? parse.businessFacts(html) : {};
  for (const [name, re] of Object.entries(src.facts || {})) {
    const v = parse.firstGroup(text, re);
    if (v) facts[name] = v;
  }
  const services = [];
  if (src.menu) services.push(...parse.menuItems(text, src.menu));
  if (src.priced_list) services.push(...parse.pricedItems(text, src.priced_list));
  const addons = src.addons ? parse.addons(text, src.addons) : [];
  const barbers = [];
  for (const p of src.people || []) {
    const name = parse.firstGroup(text, p.regex);
    if (name) barbers.push({ name, role: p.role, calendar: 'shop' });
  }
  return { facts, services, addons, barbers };
}

function readBooksy(src, html) {
  const page = parse.booksyPage(html);
  const barbers = page.staff.map((st) => ({
    name: st.name,
    role: 'barber',
    calendar: 'booksy',
    external: true,
    booking_url: src.url,
    listing_name: page.listing_name,
    hours: page.hours,
    cancellation_policy: page.cancellation_policy,
    amenities: page.amenities,
    services: page.services.filter((s) => !s.staff_ids.length || s.staff_ids.includes(st.id)).map(({ staff_ids: _drop, ...s }) => s),
  }));
  return { facts: {}, services: [], addons: [], barbers };
}

const READERS = { page: readPage, booksy: readBooksy };

async function readSource(src, opts) {
  const fetched_at = new Date((opts.now || Date.now)()).toISOString();
  const meta = { id: src.id, label: src.label, url: src.url, type: src.type, fetched_at };
  if (src.type === 'constant_url') {
    try {
      await fetchPage(src.url, opts); // only publish a link that works right now
      return { meta: { ...meta, ok: true }, facts: { [src.fact]: src.url }, services: [], addons: [], barbers: [] };
    } catch (e) { return { meta: { ...meta, ok: false, error: e.message } }; }
  }
  const reader = READERS[src.type];
  if (!reader) return { meta: { ...meta, ok: false, error: `Unknown source type ${src.type}` } };
  try {
    const out = reader(src, await fetchPage(src.url, opts));
    return { meta: { ...meta, ok: true }, ...out };
  } catch (e) {
    return { meta: { ...meta, ok: false, error: e.name === 'TimeoutError' ? 'timed out' : e.message } };
  }
}

function merge(config, results) {
  const facts = {};
  const conflicts = [];
  const services = new Map();
  const addons = new Map();
  const barbers = new Map();
  for (const r of results) {
    if (!r.meta.ok) continue;
    const from = { source: r.meta.id, url: r.meta.url };
    for (const [name, raw] of Object.entries(r.facts)) {
      const value = Array.isArray(raw) || typeof raw === 'object' ? raw : clean(raw);
      if (!facts[name]) facts[name] = { value, ...from };
      else if (key(JSON.stringify(facts[name].value)) !== key(JSON.stringify(value))) conflicts.push({ fact: name, kept: facts[name], other: { value, ...from } });
    }
    for (const s of r.services) {
      const k = key(s.name);
      const cur = services.get(k) || { name: clean(s.name, 80), sources: [] };
      for (const f of ['description', 'summary', 'price_usd', 'duration_min']) if (cur[f] == null && s[f] != null) cur[f] = clean(s[f]);
      cur.sources.push(from.source);
      services.set(k, cur);
    }
    for (const a of r.addons) if (!addons.has(key(a.name))) addons.set(key(a.name), { name: clean(a.name, 60), price_usd: a.price_usd, source: from.source });
    for (const b of r.barbers) {
      const k = key(b.name);
      const cur = barbers.get(k);
      barbers.set(k, { ...(cur || {}), ...b, name: clean(b.name, 60), role: (cur && cur.role === 'owner') ? 'owner' : b.role, sources: [...((cur && cur.sources) || []), from.source] });
    }
  }
  const name = facts.name && facts.name.value;
  return {
    shop_id: config.id,
    timezone: config.timezone,
    agent_name: config.agent_name,
    // Spoken short form: "ACME Barbershop & Lounge" -> "ACME".
    spoken_name: name ? name.replace(/\s+(?:Barbershop|Barber Shop|Barbers|Salon)\b.*$/i, '').trim() : null,
    facts,
    services: [...services.values()],
    addons: [...addons.values()],
    barbers: [...barbers.values()],
    conflicts,
    sources: results.map((r) => r.meta),
  };
}

async function pullShop(config, opts = {}) {
  const results = await Promise.all(config.sources.map((s) => readSource(s, opts)));
  return { ...merge(config, results), pulled_at: new Date((opts.now || Date.now)()).toISOString() };
}

// Keeps the latest snapshot. A call start re-pulls when it is older than ttlMs,
// but a slow source can't make a caller wait: past waitMs the call uses what we
// have and the refresh finishes for the next caller. If every source fails, the
// last good snapshot stays and is marked stale.
function createShopInfo(config, { ttlMs = 5 * 60000, waitMs = 3000, now = Date.now, fetchImpl, pull = pullShop } = {}) {
  let snapshot = null;
  let at = 0;
  let inflight = null;
  const refresh = () => {
    if (inflight) return inflight;
    inflight = pull(config, { fetchImpl, now }).then((next) => {
      if (next.sources.some((s) => s.ok)) {
        snapshot = next;
        at = now();
      } else if (snapshot) {
        snapshot = { ...snapshot, stale: true, sources: next.sources };
      } else {
        snapshot = next;
      }
      return snapshot;
    }).finally(() => { inflight = null; });
    return inflight;
  };
  return {
    refresh,
    current: () => snapshot,
    async forCall() {
      if (snapshot && now() - at < ttlMs) return snapshot;
      const pending = refresh();
      if (!snapshot) return pending;
      return Promise.race([pending, new Promise((r) => setTimeout(() => r(snapshot), waitMs).unref())]);
    },
  };
}

module.exports = { pullShop, createShopInfo, fetchPage, readPage, readBooksy };
