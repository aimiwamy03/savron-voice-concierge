// Display only: turns spoken number words in transcript lines into digits so
// the on page transcript is easy to scan ("four one five, five five five,
// zero one zero zero" -> "(415) 555-0100", "forty five dollars" -> "$45",
// "B K one zero zero one" -> "BK1001", "two thirty" -> "2:30",
// "October twenty fifth" -> "October 25"). What Mia says out loud is not
// changed; this only runs on the text the page shows. UMD so Node tests can
// require it and the browser can load it with a script tag.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Digits = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
  const ORD = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30 };
  const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
  const UNIT_AFTER = /^(dollars?|bucks|minutes?|mins?|hours?|stars?|miles?|days?|weeks?|people|percent|am|pm|a\.m\.|p\.m\.|o'clock|noon)$/i;

  function classify(word) {
    const w = word.toLowerCase();
    const u = UNITS.indexOf(w);
    if (u >= 0) return { w, val: u, kind: u < 10 ? 'digit' : 'teen' };
    if (w in TENS) return { w, val: TENS[w], kind: 'tens' };
    if (w === 'hundred') return { w, val: 100, kind: 'hundred' };
    if (w === 'thousand') return { w, val: 1000, kind: 'thousand' };
    if (w === 'oh') return { w, val: 0, kind: 'oh' };
    return null;
  }

  // Month + ordinal day: "October twenty fifth" -> "October 25".
  function dates(text) {
    const re = new RegExp(`\\b(${MONTHS})(\\s+)(?:(twenty|thirty)[\\s-]+)?(${Object.keys(ORD).join('|')})\\b`, 'gi');
    return text.replace(re, (_m, month, sp, tens, ord) => `${month}${sp}${(tens ? TENS[tens.toLowerCase()] : 0) + ORD[ord.toLowerCase()]}`);
  }

  // Parse a cardinal run like [forty, five] or [one, hundred, twenty]; null if it is not one number.
  function cardinal(items) {
    let total = 0, cur = 0, last = null;
    for (const it of items) {
      if (it.kind === 'digit' || it.kind === 'teen') {
        if (last === 'digit' || last === 'teen') return null;
        if (last === 'tens' && it.kind === 'teen') return null;
        cur += it.val;
      } else if (it.kind === 'tens') {
        if (last === 'digit' || last === 'teen' || last === 'tens') return null;
        cur += it.val;
      } else if (it.kind === 'hundred') {
        if (!cur) cur = 1;
        cur *= 100;
      } else if (it.kind === 'thousand') {
        total += (cur || 1) * 1000; cur = 0;
      } else return null;
      last = it.kind;
    }
    return total + cur;
  }

  // "two thirty", "eleven forty five", "two oh five" -> clock time.
  function clock(items) {
    if (items.length < 2) return null;
    const h = items[0];
    if (!(h.kind === 'digit' || h.kind === 'teen') || h.val < 1 || h.val > 12) return null;
    const rest = items.slice(1);
    if (rest[0].kind === 'oh' && rest.length === 2 && rest[1].kind === 'digit' && rest[1].val > 0) return `${h.val}:0${rest[1].val}`;
    const m = cardinal(rest);
    if (m === null || m < 10 || m > 59 || rest.some((x) => x.kind === 'hundred' || x.kind === 'thousand')) return null;
    return `${h.val}:${String(m).padStart(2, '0')}`;
  }

  function digitsOnly(items) { return items.every((x) => x.kind === 'digit' || x.kind === 'oh'); }

  function formatDigits(ds) {
    if (ds.length === 10) return `(${ds.slice(0, 3)}) ${ds.slice(3, 6)}-${ds.slice(6)}`;
    if (ds.length === 11 && ds[0] === '1') return `1 (${ds.slice(1, 4)}) ${ds.slice(4, 7)}-${ds.slice(7)}`;
    if (ds.length === 7) return `${ds.slice(0, 3)}-${ds.slice(3)}`;
    return ds;
  }

  function convertRun(items, prevWord, nextWord, prevNumeric) {
    const next = (nextWord || '').toLowerCase();
    const unitAfter = UNIT_AFTER.test(next);
    if (items.length === 3 && items[1].kind === 'oh') { const t = clock(items); if (t) return t; }
    if (digitsOnly(items)) {
      if (items[0].kind === 'oh') return null;
      if (items.length >= 2) return formatDigits(items.map((x) => x.val).join(''));
      // Lone small number words stay words unless the context says it is a quantity or a time.
      const atTime = /^(at|by|from|to|until|til|before|after|around)$/i.test(prevWord || '') || (/^(or|and)$/i.test(prevWord || '') && prevNumeric);
      if (unitAfter || (atTime && items[0].val >= 1)) return String(items[0].val);
      return null;
    }
    const isMoney = /^(dollars?|bucks)$/.test(next);
    const t = clock(items);
    if (t && !isMoney && !/^(minutes?|hours?|people|miles?)$/.test(next)) return t;
    if (t && isMoney) return t.replace(':', ''); // "one fifty dollars" -> 150
    const n = cardinal(items);
    if (n !== null) return String(n);
    // Not one number (like "twenty five thirty"): convert greedy chunks.
    const out = [];
    let chunk = [];
    for (const it of items) {
      const tryChunk = [...chunk, it];
      if (cardinal(tryChunk) !== null) chunk = tryChunk;
      else { if (chunk.length) out.push(cardinal(chunk)); chunk = [it]; }
    }
    if (chunk.length) out.push(cardinal(chunk));
    return out.join(' ');
  }

  function numbers(text) {
    const toks = text.match(/[A-Za-z]+(?:'[A-Za-z]+)?|[^A-Za-z]+/g) || [];
    const out = [];
    let i = 0;
    const isWord = (t) => /^[A-Za-z]/.test(t || '');
    const lastWord = () => { for (let k = out.length - 1; k >= 0; k--) if (isWord(out[k])) return out[k]; return ''; };
    while (i < toks.length) {
      const c = isWord(toks[i]) ? classify(toks[i]) : null;
      if (!c || c.kind === 'oh' || c.kind === 'hundred' || c.kind === 'thousand') { out.push(toks[i]); i++; continue; }
      const items = [c];
      let j = i + 1;
      while (j + 1 < toks.length) {
        const sep = toks[j];
        const nx = isWord(toks[j + 1]) ? classify(toks[j + 1]) : null;
        if (!nx) break;
        const prev = items[items.length - 1];
        const plain = /^[ \t]*-?[ \t]*$/.test(sep) && sep.length > 0;
        const groupSep = /^,?[ \t]+$|^,$/.test(sep) && /,/.test(sep);
        const bothDigits = (prev.kind === 'digit' || prev.kind === 'oh') && (nx.kind === 'digit' || nx.kind === 'oh');
        if (plain || (groupSep && bothDigits)) { items.push(nx); j += 2; continue; }
        break;
      }
      // word after the run, for "dollars", "pm", and similar
      let nextWord = '';
      if (j < toks.length && /^[ \t]+$/.test(toks[j]) && isWord(toks[j + 1])) nextWord = toks[j + 1];
      // was the last thing before "or"/"and" a number, as in "two thirty or three"?
      const before = out.join('').replace(/\s*\b(or|and)\s*$/i, '');
      const conv = convertRun(items, lastWord(), nextWord, /\d[\s,]*$/.test(before));
      if (conv === null) { out.push(toks[i]); i++; continue; }
      if (/^(dollars?|bucks)$/i.test(nextWord)) { out.push(`$${conv}`); i = j + 2; continue; }
      out.push(conv);
      i = j;
    }
    return out.join('');
  }

  function post(text) {
    return text
      // "B K 1001" or "B, K, 1001" -> "BK1001" (confirmation codes)
      .replace(/\b([A-Z])[ ,.-]+([A-Z])(?:[ ,.-]+([A-Z]))?[ ,.-]+(\d{3,})\b/g, (_m, a, b, c, d) => `${a}${b}${c || ''}${d}`)
      .replace(/\b(\d{1,2}(?::\d\d)?) ?(?:a\.m\.|a\. m\.|a ?m\b)/gi, '$1 AM')
      .replace(/\b(\d{1,2}(?::\d\d)?) ?(?:p\.m\.|p\. m\.|p ?m\b)/gi, '$1 PM');
  }

  // "four point eight" -> "4.8" (ratings)
  function decimals(text) {
    return text.replace(/\b([A-Za-z]+) point ([A-Za-z]+)\b/g, (m, a, b) => {
      const x = classify(a), y = classify(b);
      return x && y && x.kind === 'digit' && y.kind === 'digit' ? `${x.val}.${y.val}` : m;
    });
  }

  function toDisplay(text) {
    if (typeof text !== 'string' || !text) return text;
    return post(numbers(decimals(dates(text))));
  }

  return { toDisplay };
}));
