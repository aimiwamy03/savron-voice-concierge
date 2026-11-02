// The build sheet's first 10 test calls, typed into a real agent through our
// server. Uses Deepgram credit. Pass or fail is judged from tool calls and words.
//   npm run test:calls               all of them
//   npm run test:calls -- 3,6        some of them
const WebSocket = require('ws');
const { createServer, loadShopConfig, defaultShopId } = require('../server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const said = (rec) => rec.transcript.filter((t) => t.role === 'assistant').map((t) => t.content).join(' ');
const called = (rec, name) => rec.tools.filter((t) => t.name === name && t.result.ok);
const check = (cond, label) => (cond ? null : label);
const CALLER = ['Sam Rivera', '6125550142'];
const SPOKEN = 'six one two, five five five, zero one four two';

const CALLS = [
  { id: 1, name: 'Walk-ins and current wait', turns: ["Do you take walk-ins? How long's the wait right now?"],
    grade: (r) => [check(/walk/i.test(said(r)), 'mentions walk-ins'), check(!/\b\d+\s*(minutes?|min)\b/i.test(said(r)), 'does not invent a wait')] },
  { id: 2, name: 'Fade with a design', turns: ['How much is a fade with a design?'],
    grade: (r) => [check(/65|sixty[- ]five/i.test(said(r)), 'quotes the live design price'), check(/kris/i.test(said(r)), 'says it is Kris')] },
  { id: 3, name: 'Signature Cut with the owner on Saturday', turns: ['I want a Signature Cut with Albe this Saturday around two.', `It's ${CALLER[0]}, my number is ${SPOKEN}.`, 'Yes, that is all correct.', 'Yes, go ahead.'],
    grade: (r) => [check(called(r, 'book').length, 'book succeeded'), check(called(r, 'send_confirmation').length, 'text sent')] },
  { id: 4, name: 'Booksy barber goes to approval', turns: ['Can I get an adult haircut with Kris this Saturday around noon?', `It's ${CALLER[0]}, my number is ${SPOKEN}.`, 'Yes, correct.', 'Yes, go ahead.'],
    grade: (r) => [check(called(r, 'request_approval').length, 'request_approval succeeded'), check(!called(r, 'book').length, 'did not use book')] },
  { id: 5, name: 'Reschedule', turns: [`I need to move my appointment to next Thursday at three. The number on it is ${SPOKEN}.`, 'Yes, please move it.', 'Yes.'],
    grade: (r) => [check(called(r, 'reschedule').length, 'reschedule succeeded')] },
  { id: 6, name: 'Spanish caller, kids cut', turns: ['Hola, quisiera una cita para un corte de niño para mi hijo este sábado a las once, con el primero disponible.', 'Me llamo Sam Rivera, mi número es seis uno dos, cinco cinco cinco, cero uno cuatro dos.', 'Sí, es correcto.', 'Sí, adelante.'],
    grade: (r) => [check(r.languages.includes('es'), 'voice switched to Spanish'), check(/ñ|¿|usted|su /i.test(said(r)), 'replies in Spanish'), check(called(r, 'book').length, 'book succeeded')] },
  { id: 7, name: 'Switches language mid call', turns: ['Hi, where are you located?', 'Perdón, ¿puede hablar en español? ¿Cuál es la dirección?'],
    grade: (r) => [check(r.languages.includes('es'), 'voice switched to Spanish')] },
  { id: 8, name: 'Parking', turns: ['Where do I park?'],
    grade: (r) => [check(called(r, 'notify_shop').length || /team|follow/i.test(said(r)), 'defers to the team'), check(!/\b(ramp|garage|lot)\b/i.test(said(r).replace(/parking lot/gi, '')), 'does not invent parking')] },
  { id: 9, name: 'Membership', turns: ['How do I get on the list? Is there a membership?'],
    grade: (r) => [check(/invit|wallet|pass/i.test(said(r)), 'uses the live membership facts')] },
  { id: 10, name: 'Angry caller', turns: ['This is ridiculous, my barber butchered my hair and nobody answers. I want to talk to a person now.', `It's ${CALLER[0]}, call me at ${CALLER[1]}.`],
    grade: (r) => [check(called(r, 'notify_shop').length, 'notify_shop succeeded')] },
];

function runCall(port, call) {
  return new Promise((resolve) => {
    const rec = { transcript: [], tools: [], languages: [], errors: [] };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/call`);
    let last = Date.now();
    let live = false;
    ws.on('message', (data, isBinary) => {
      if (isBinary) { last = Date.now(); return; }
      const m = JSON.parse(data);
      last = Date.now();
      if (m.type === 'status' && m.status === 'live') live = true;
      if (m.type === 'ConversationText') rec.transcript.push({ role: m.role, content: m.content });
      if (m.type === 'tool') rec.tools.push(m);
      if (m.type === 'language') rec.languages.push(m.language);
      if (m.type === 'Error') rec.errors.push(m.description || m.code);
    });
    const quiet = async () => { // let the agent finish talking and acting
      await sleep(1500);
      while (Date.now() - last < 2500) await sleep(250);
    };
    ws.on('open', async () => {
      while (!live && !rec.errors.length) await sleep(100);
      await quiet();
      for (const line of call.turns) {
        if (rec.errors.length) break;
        ws.send(JSON.stringify({ type: 'text', content: line }));
        await quiet();
      }
      ws.send(JSON.stringify({ type: 'hangup' }));
      ws.close();
      resolve(rec);
    });
    ws.on('error', (e) => { rec.errors.push(e.message); resolve(rec); });
  });
}

(async () => {
  if (!process.env.DEEPGRAM_API_KEY) { console.error('DEEPGRAM_API_KEY is not set. These calls use a real agent.'); process.exit(2); }
  const only = process.argv[2] ? process.argv[2].split(',').map(Number) : null;
  const { server, info } = createServer({ config: loadShopConfig(defaultShopId()), log: () => {} });
  await info.refresh();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  let failed = 0;
  for (const call of CALLS.filter((c) => !only || only.includes(c.id))) {
    const rec = await runCall(port, call);
    const problems = [...rec.errors.map((e) => `error: ${e}`), ...call.grade(rec).filter(Boolean).map((p) => `expected: ${p}`)];
    console.log(`${problems.length ? 'FAIL' : 'PASS'} ${call.id}. ${call.name}`);
    if (problems.length) {
      failed++;
      for (const p of problems) console.log(`     ${p}`);
      for (const t of rec.transcript) console.log(`     ${t.role}: ${t.content}`);
    }
  }
  server.close();
  process.exit(failed ? 1 : 0);
})();
