// Did the agent read a phone number back to the caller? Used to gate writes
// that store a callback number (book_appointment, take_message): the number
// must appear in something the agent said, digit by digit, and the caller must
// have spoken after that (so they had a chance to correct it).
//
// spokenDigitRuns() turns "four one five, five five five, zero one two three",
// "cuatro uno cinco ...", "四一五，五五五，零一二三" or "(415) 555-0123" into
// runs of digits. A run continues across spaces, commas, dashes, "and"/"y"
// and the like, and breaks at any other word, so "two thirty" never pollutes a
// phone number.

const WORD_DIGITS = {
  // English
  zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  // Spanish
  cero: '0', uno: '1', una: '1', dos: '2', tres: '3', cuatro: '4', cinco: '5', seis: '6', siete: '7', ocho: '8', nueve: '9',
};
const ZH_DIGITS = { '零': '0', '〇': '0', '一': '1', '幺': '1', '二': '2', '两': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9' };
const REPEAT = { double: 2, triple: 3, doble: 2, triple_es: 3 };
const GLUE = new Set(['and', 'y', 'dash', 'guion', 'guión']);

function tokenize(text) {
  const out = [];
  // Chinese digits become separate tokens; other text splits on non letters/digits.
  const s = String(text || '').replace(/[零〇一幺二两三四五六七八九]/g, (c) => ` ${ZH_DIGITS[c]} `);
  for (const m of s.toLowerCase().matchAll(/[a-záéíóúñü]+|\d+|[^\sa-záéíóúñü\d]/g)) out.push(m[0]);
  return out;
}

function spokenDigitRuns(text) {
  const runs = [];
  let cur = '';
  let repeat = 1;
  const flush = () => { if (cur) runs.push(cur); cur = ''; repeat = 1; };
  const toks = tokenize(text);
  const isDigit = (t) => t !== undefined && (/^\d+$/.test(t) || (WORD_DIGITS[t] !== undefined && t !== 'o' && t !== 'oh'));
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (/^\d+$/.test(t)) { cur += t.repeat(repeat); repeat = 1; continue; }
    if (WORD_DIGITS[t] !== undefined) {
      // "o"/"oh" starts a run only right before another digit ("oh one two"), never in "oh, hi".
      if ((t === 'o' || t === 'oh') && !cur && !isDigit(toks[i + 1])) { flush(); continue; }
      cur += WORD_DIGITS[t].repeat(repeat); repeat = 1; continue;
    }
    if (REPEAT[t]) { repeat = REPEAT[t]; continue; }
    if (GLUE.has(t) || /^[,\-.()–·、，。\s]$/.test(t)) {
      if (t === '.' || t === '。') { flush(); continue; } // sentence end
      continue;
    }
    flush();
  }
  flush();
  return runs;
}

// True if `phone` (10 digits) was said by the agent in one run, or as area code
// plus the remaining seven digits in consecutive runs ("four one five. Five five five...").
function saidPhone(text, phone) {
  if (!phone) return false;
  const runs = spokenDigitRuns(text);
  if (runs.some((r) => r.includes(phone))) return true;
  const joined = runs.join('');
  return joined.includes(phone);
}

// history: [{ role: 'user'|'assistant', content }] in order.
function phoneReadBack(history, phone) {
  let readAt = -1;
  history.forEach((h, i) => { if (h.role === 'assistant' && saidPhone(h.content, phone)) readAt = i; });
  if (readAt < 0) return { ok: false, reason: 'NOT_READ_BACK' };
  const confirmed = history.slice(readAt + 1).some((h) => h.role === 'user');
  return confirmed ? { ok: true } : { ok: false, reason: 'NOT_CONFIRMED' };
}

module.exports = { spokenDigitRuns, saidPhone, phoneReadBack };
