// Pure page parsing. No network, and nothing shop specific.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s) {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// One line per block of visible text.
function pageText(html) {
  const body = String(html)
    .replace(/<(script|style|svg|noscript|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, '');
  // Inline tags do not break a sentence, so "at <a>booking</a> now" stays one line.
  const text = body
    .replace(/<\/?(a|b|i|em|strong|span|u|small)\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '\n');
  return decode(text).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

function jsonLd(html) {
  const out = [];
  for (const m of String(html).matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const d = JSON.parse(m[1]);
      out.push(...(Array.isArray(d) ? d : d['@graph'] || [d]));
    } catch { /* one bad block should not lose the page */ }
  }
  return out;
}

const BUSINESS_TYPES = /BarberShop|HairSalon|BeautySalon|LocalBusiness|HealthAndBeautyBusiness/;
const WEEKDAY = { sunday: 'sun', monday: 'mon', tuesday: 'tue', wednesday: 'wed', thursday: 'thu', friday: 'fri', saturday: 'sat' };

// schema.org openingHoursSpecification -> { tue: ['10:00','20:00'], ... }
function jsonLdHours(biz) {
  const hours = {};
  for (const spec of [].concat(biz.openingHoursSpecification || [])) {
    for (const day of [].concat(spec.dayOfWeek || [])) {
      const key = WEEKDAY[String(day).split('/').pop().toLowerCase()];
      if (key && spec.opens && spec.closes) hours[key] = [spec.opens.slice(0, 5), spec.closes.slice(0, 5)];
    }
  }
  return Object.keys(hours).length ? hours : null;
}

function businessFacts(html) {
  const biz = jsonLd(html).find((x) => BUSINESS_TYPES.test([].concat(x['@type'] || []).join(' ')));
  if (!biz) return {};
  const a = biz.address || {};
  const r = biz.aggregateRating || {};
  const facts = {
    name: biz.name,
    website: biz.url,
    email: biz.email,
    phone: biz.telephone,
    address: a.streetAddress && [a.streetAddress, a.addressLocality, [a.addressRegion, a.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    rating: r.ratingValue,
    review_count: r.reviewCount,
    socials: [].concat(biz.sameAs || []),
    shop_hours: jsonLdHours(biz),
  };
  return Object.fromEntries(Object.entries(facts).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

const firstGroup = (text, source) => {
  const m = text.match(new RegExp(source, 'm'));
  return m ? m[1].trim() : null;
};

// The list on a shop's page: each item ends with a marker such as a Book link,
// and its last two lines are the name and the description.
function menuItems(text, { start, end, item_end: itemEnd }) {
  const from = text.indexOf(start);
  if (from < 0) return [];
  const to = text.indexOf(end, from);
  const section = text.slice(from + start.length, to < 0 ? undefined : to);
  const parts = section.split(itemEnd).slice(0, -1);
  return parts.map((part) => {
    const lines = part.split('\n').map((l) => l.trim()).filter((l) => l && !/^\d+$/.test(l));
    return lines.length >= 2 ? { name: lines[lines.length - 2], description: lines[lines.length - 1] } : null;
  }).filter(Boolean);
}

function pricedItems(text, source) {
  return [...text.matchAll(new RegExp(source, 'gm'))].map((m) => ({
    name: m[1].trim(), summary: m[2].trim(), price_usd: Number(m[3]), duration_min: Number(m[4]),
  }));
}

function addons(text, source) {
  return [...text.matchAll(new RegExp(source, 'gm'))].map((m) => ({ name: m[1].trim(), price_usd: Number(m[2]) }));
}

// Nuxt pages keep their data in an indexed array where numbers point at other
// entries. Rebuild the part we need.
function nuxtData(html) {
  const m = String(html).match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  const arr = JSON.parse(m[1]);
  const seen = new Map();
  const at = (i) => (Number.isInteger(i) && i >= 0 && i < arr.length ? value(arr[i], i) : i);
  function value(x, i) {
    if (seen.has(i)) return seen.get(i);
    if (Array.isArray(x)) {
      if (['ShallowReactive', 'Reactive', 'Ref', 'ShallowRef'].includes(x[0])) return at(x[1]);
      const out = [];
      seen.set(i, out);
      for (const e of x) out.push(at(e));
      return out;
    }
    if (x && typeof x === 'object') {
      const out = {};
      seen.set(i, out);
      for (const k of Object.keys(x)) out[k] = at(x[k]);
      return out;
    }
    return x;
  }
  return { find(pred) { const i = arr.findIndex(pred); return i < 0 ? null : value(arr[i], i); } };
}

const DAY_INDEX = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// A public Booksy business page: one calendar outside the shop's own system.
function booksyPage(html) {
  const data = nuxtData(html);
  const biz = data && data.find((x) => x && typeof x === 'object' && !Array.isArray(x) && 'serviceCategories' in x && 'staff' in x);
  if (!biz) throw new Error('Booksy page layout not recognized');
  const hours = {};
  for (const h of biz.openHours || []) hours[DAY_INDEX[h.dayOfWeek]] = [h.openFrom, h.openTill];
  const services = [];
  for (const cat of biz.serviceCategories || []) {
    for (const s of cat.services || []) {
      const v = (s.variants || [])[0] || {};
      services.push({
        name: s.name,
        description: s.description || null,
        price_usd: typeof v.price === 'number' ? v.price : null,
        price_is_starting: /\+\s*$/.test(v.servicePrice || ''),
        online_discount_price: (v.promotion && v.promotion.price && v.promotion.price.formattedPrice) || null,
        duration_min: v.duration ?? null,
        staff_ids: s.stafferId || v.stafferId || [],
      });
    }
  }
  const policy = String(biz.depositPolicy || '').split('\n')[0] || null;
  return {
    listing_name: biz.name,
    staff: (biz.staff || []).map((s) => ({ id: s.id, name: s.name })),
    hours: Object.keys(hours).length ? hours : null,
    services,
    cancellation_policy: policy,
    amenities: (biz.amenities || []).map((a) => a.label),
  };
}

module.exports = { decode, pageText, jsonLd, businessFacts, firstGroup, menuItems, pricedItems, addons, booksyPage };
