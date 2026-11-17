const test = require('node:test');
const assert = require('node:assert');
const { phoneReadBack, phoneInWords } = require('../src/readback');

const said = (content) => [{ role: 'assistant', content }, { role: 'user', content: 'yes' }];

test('a number counts as read back only when the digits are spoken as words', () => {
  assert.deepStrictEqual(phoneReadBack(said('Six one two, five five five, zero one four seven. Right?'), '6125550147'), { ok: true });
  assert.deepStrictEqual(phoneReadBack(said('Seis uno dos, cinco cinco cinco, cero uno cuatro siete. ¿Correcto?'), '6125550147'), { ok: true });
  assert.strictEqual(phoneReadBack(said('Jordan, 6125550147. Correct?'), '6125550147').reason, 'NOT_IN_WORDS');
  assert.strictEqual(phoneReadBack(said('That is (612) 555-0147, right?'), '6125550147').reason, 'NOT_IN_WORDS');
  // A short time in the same sentence is fine.
  assert.deepStrictEqual(phoneReadBack(said('Saturday at 3, and six one two, five five five, zero one four seven?'), '6125550147'), { ok: true });
});

test('phoneInWords gives three spoken groups in either language', () => {
  assert.strictEqual(phoneInWords('6125550147'), 'six one two, five five five, zero one four seven');
  assert.strictEqual(phoneInWords('6125550147', 'es'), 'seis uno dos, cinco cinco cinco, cero uno cuatro siete');
});
