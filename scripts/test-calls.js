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
    grade: (r) => [check(called(r, 'notify_shop').length, 'notify_shop succeeded')], judge: 'calm_caring' },
  { id: 11, name: 'Cancel', turns: [`I need to cancel my appointment. The number on it is ${SPOKEN}.`, 'Yes, cancel it.'],
    grade: (r) => [check(called(r, 'cancel').length, 'cancel succeeded'), check(!/reschedul|rebook|another time|come back/i.test(said(r)), 'does not push back or upsell')] },
  { id: 12, name: 'Changes their mind', turns: ['Can I book a Signature Cut with Albe this Saturday at three?', `Actually no, make it four. It's ${CALLER[0]}, my number is ${SPOKEN}.`, 'Yes, that is correct.', 'Yes, go ahead.'],
    grade: (r) => {
      const books = called(r, 'book');
      const finalTime = books.length ? books[books.length - 1].arguments.time : null;
      return [check(books.length, 'book succeeded'), check(finalTime === '16:00', 'final time is 4pm (16:00)'), check(/\b(four|4)\b/i.test(said(r)), 'read-back says 4')];
    } },
];

// Call 13 is documented below but skipped in automated testing, as it requires real audio barge-in.
const CEKURA_ONLY = [
  { id: 13, name: 'Talks over the agent', scenario: 'Caller asks "What services do you offer?" then interrupts mid-answer with "Actually, I just want to book a haircut." The agent should stop talking, answer the new question, and retain any booking details.', pass: 'Agent stops when interrupted, answers the new question, and keeps booking context.' },
];

// AI-judge checks, run only when OPENAI_API_KEY is set.
// Calls OpenAI's chat API to evaluate subjective qualities.
async function callJudge(prompt) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
      }),
    });
    if (!resp.ok) return { error: `OpenAI API: ${resp.status}` };
    const data = await resp.json();
    return data.choices[0].message.content.trim();
  } catch (e) {
    return { error: e.message };
  }
}

function parseJudge(text) {
  if (!text || text.error) return { pass: false, reason: text ? text.error : 'no judge response' };
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const verdict = lines[0].toLowerCase();
  const pass = /^pass/.test(verdict);
  const reason = lines.slice(1).join(' ') || verdict;
  return { pass, reason };
}

async function judgeCall(call, rec, shopSnapshot) {
  if (!process.env.OPENAI_API_KEY) return [];
  const judgments = [];
  const transcript = rec.transcript.map((t) => `${t.role}: ${t.content}`).join('\n');

  // Calm and caring for angry caller (call 10)
  if (call.judge === 'calm_caring') {
    const prompt = `A customer called a barbershop upset. Evaluate if the agent was calm, caring, and empathetic (not robotic or dismissive). Answer with PASS or FAIL on the first line, then a one-line reason.

Transcript:
${transcript}`;
    const result = await callJudge(prompt);
    const parsed = parseJudge(result);
    judgments.push({ label: 'AI judge (calm & caring)', ...parsed });
  }

  // Natural Spanish for calls 6 and 7
  if ([6, 7].includes(call.id)) {
    const prompt = `A customer spoke Spanish on a phone call. Evaluate if the agent's Spanish responses sound natural and idiomatic (not word-for-word translated English). Answer with PASS or FAIL on the first line, then a one-line reason.

Transcript:
${transcript}`;
    const result = await callJudge(prompt);
    const parsed = parseJudge(result);
    judgments.push({ label: 'AI judge (natural Spanish)', ...parsed });
  }

  // Unsupported facts check for all calls
  const shopFacts = JSON.stringify(shopSnapshot, null, 2);
  const factPrompt = `A customer called a barbershop. The agent should only state facts supported by the shop data below. Evaluate if the agent stated any fact (name, price, policy, location detail, parking, hours, etc.) not found in the shop data. Answer with PASS if all facts are supported, FAIL if any fact is unsupported, then a one-line reason with the unsupported claim if any.

Shop data:
${shopFacts}

Transcript:
${transcript}`;
  const factResult = await callJudge(factPrompt);
  const factParsed = parseJudge(factResult);
  judgments.push({ label: 'AI judge (no unsupported facts)', ...factParsed });

  return judgments;
}

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
  const shopSnapshot = info.snapshot();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  
  if (!process.env.OPENAI_API_KEY) console.log('OPENAI_API_KEY not set. AI judge checks will be skipped.\n');
  
  let failed = 0;
  for (const call of CALLS.filter((c) => !only || only.includes(c.id))) {
    const rec = await runCall(port, call);
    const ruleProblems = [...rec.errors.map((e) => `error: ${e}`), ...call.grade(rec).filter(Boolean).map((p) => `expected: ${p}`)];
    const judgeResults = await judgeCall(call, rec, shopSnapshot);
    const judgeProblems = judgeResults.filter((j) => !j.pass).map((j) => `${j.label}: ${j.reason}`);
    const allProblems = [...ruleProblems, ...judgeProblems];
    
    console.log(`${allProblems.length ? 'FAIL' : 'PASS'} ${call.id}. ${call.name}`);
    if (allProblems.length) {
      failed++;
      for (const p of allProblems) console.log(`     ${p}`);
      for (const t of rec.transcript) console.log(`     ${t.role}: ${t.content}`);
    }
    for (const j of judgeResults.filter((j) => j.pass)) console.log(`     ${j.label}: pass`);
  }
  
  if (CEKURA_ONLY.length) {
    console.log(`\nCekura-only tests (require real audio barge-in over Twilio):`);
    for (const c of CEKURA_ONLY) {
      console.log(`  ${c.id}. ${c.name}`);
      console.log(`      Scenario: ${c.scenario}`);
      console.log(`      Pass if: ${c.pass}`);
    }
  }
  
  server.close();
  process.exit(failed ? 1 : 0);
})();
