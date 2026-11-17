const test = require('node:test');
const assert = require('node:assert');
const { detectLanguage } = require('../src/languages');

test('a one or two word answer never switches the language', () => {
  // Flux can tag a bare name as English in the middle of a Spanish call.
  assert.strictEqual(detectLanguage({ content: 'Lucía', languages: ['en'] }), null);
  assert.strictEqual(detectLanguage({ content: 'Sí, correcto', languages: ['en'] }), null);
  assert.strictEqual(detectLanguage({ content: 'okay', languages: ['en'] }), null);
});

test('a real sentence still switches', () => {
  assert.strictEqual(detectLanguage({ content: 'perdón, mejor en español por favor' }), 'es');
  assert.strictEqual(detectLanguage({ content: 'Can I book a haircut', languages: ['en'] }), 'en');
  assert.strictEqual(detectLanguage({ content: 'Quiero una cita para mi hijo', languages: ['es'] }), 'es');
});
