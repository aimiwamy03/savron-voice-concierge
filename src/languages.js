// English and Spanish. flux-general-multi hears both and takes turns well.
const NAMES = { en: 'English', es: 'Spanish' };

const config = (env = process.env) => ({
  voiceEn: env.VOICE_EN || 'aura-2-helena-en',
  voiceEs: env.VOICE_ES || 'aura-2-selena-es',
});

const listenProvider = (keyterms) => ({ type: 'deepgram', version: 'v2', model: 'flux-general-multi', language_hints: ['en', 'es'], keyterms, eot_threshold: 0.7, eot_timeout_ms: 5000 });

const speakFor = (lang, cfg) => ({ provider: { type: 'deepgram', version: 'v1', model: lang === 'es' ? cfg.voiceEs : cfg.voiceEn, speed: 1.0 } });

const ES_WORDS = new Set(['hola', 'quiero', 'quisiera', 'necesito', 'puedo', 'para', 'cita', 'corte', 'gracias', 'por', 'favor', 'mañana', 'hoy', 'sí', 'buenos', 'buenas', 'días', 'tardes', 'una', 'el', 'la', 'los', 'las', 'con', 'mi', 'es', 'de', 'que', 'hablo', 'español', 'cuánto', 'cuesta', 'hijo', 'niño', 'sábado', 'nombre', 'teléfono', 'número', 'llamo', 'usted', 'puede', 'tiene', 'hay', 'cuándo', 'dónde', 'qué', 'está']);
const EN_WORDS = new Set(['the', 'i', 'want', 'to', 'a', 'an', 'is', 'my', 'and', 'for', 'can', 'please', 'yes', 'book', 'haircut', 'what', 'how', 'thanks', 'you', 'it', 'that', 'do', 'have', 'with', 'this', 'at', 'on', 'of', 'in', 'would', 'like', 'need', 'get', 'could', 'are', 'we', 'me', 'your', 'appointment', 'time']);

// Best guess from one caller turn, so the reply can already use the right voice.
function detectLanguage(msg) {
  if (Array.isArray(msg.languages) && msg.languages.length) {
    const top = String(msg.languages[0]).toLowerCase().split('-')[0];
    if (NAMES[top]) return top;
  }
  const text = String(msg.content || '');
  const words = text.toLowerCase().match(/[a-záéíóúñü]+/g) || [];
  let es = /[ñ¿¡áéíóú]/.test(text) ? 1 : 0;
  let en = 0;
  for (const w of words) { if (ES_WORDS.has(w)) es++; if (EN_WORDS.has(w)) en++; }
  if (es >= 2 && es > en) return 'es';
  if (en >= 2 && en > es) return 'en';
  return null;
}

module.exports = { NAMES, config, listenProvider, speakFor, detectLanguage };
