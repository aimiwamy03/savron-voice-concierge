// A full call against fake Deepgram and fake Twilio sockets.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');
const { createServer } = require('../server');
const { validSignature } = require('../src/twilio');

const SHOP = {
  shop_id: 'x', spoken_name: 'Shop', agent_name: 'Ana', timezone: 'America/Chicago', conflicts: [],
  facts: { name: { value: 'Shop Barbers' } }, addons: [], sources: [],
  services: [{ name: 'House Cut' }],
  barbers: [{ name: 'Dee Owner', role: 'owner', calendar: 'shop' }],
};
const clock = () => new Date('2026-11-02T16:00:00Z');
const once = (emitter, ev) => new Promise((r) => emitter.once(ev, r));

async function rig(env = {}) {
  const dgServer = new WebSocket.Server({ port: 0, host: '127.0.0.1' });
  await once(dgServer, 'listening');
  const app = createServer({
    config: { id: 'x' }, clock, log: () => {},
    env: { DEEPGRAM_API_KEY: 'k', ...env },
    agentUrl: `ws://127.0.0.1:${dgServer.address().port}`,
    shopInfo: { forCall: async () => SHOP, current: () => SHOP, refresh: async () => SHOP },
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  return { ...app, dgServer, port: app.server.address().port, stop: () => { for (const c of dgServer.clients) c.terminate(); dgServer.close(); app.server.closeAllConnections(); app.server.close(); } };
}

function collector(ws) {
  const msgs = [];
  const waiting = [];
  ws.on('message', (d, bin) => {
    const m = bin ? { binary: d } : JSON.parse(d);
    msgs.push(m);
    for (const w of [...waiting]) if (w.pred(m)) { waiting.splice(waiting.indexOf(w), 1); w.res(m); }
  });
  return { msgs, until: (pred) => new Promise((res) => { const hit = msgs.find(pred); if (hit) res(hit); else waiting.push({ pred, res }); }) };
}

test('the phone number gate blocks a booking until the read back, then the live shop data is used', async () => {
  const r = await rig();
  const dgConn = once(r.dgServer, 'connection');
  const ws = new WebSocket(`ws://127.0.0.1:${r.port}/call`);
  const caller = collector(ws);
  const dg = await dgConn;
  const agent = collector(dg);
  const settings = await agent.until((m) => m.type === 'Settings');
  assert.match(settings.agent.greeting, /Thanks for calling Shop, this is Ana/);
  assert.match(settings.agent.think.prompt, /Shop Barbers/);
  dg.send(JSON.stringify({ type: 'SettingsApplied' }));
  await caller.until((m) => m.status === 'live');

  const args = JSON.stringify({ service: 'House Cut', barber: 'Dee', date: '2026-11-07', time: '14:00', customer_name: 'Sam', customer_phone: '6125550142' });
  dg.send(JSON.stringify({ type: 'FunctionCallRequest', functions: [{ id: '1', name: 'book', arguments: args, client_side: true }] }));
  const first = await agent.until((m) => m.type === 'FunctionCallResponse' && m.id === '1');
  assert.strictEqual(JSON.parse(first.content).error, 'READ_BACK_PHONE_FIRST');
  assert.strictEqual(r.ledger.list().requests.length, 0);

  dg.send(JSON.stringify({ type: 'ConversationText', role: 'assistant', content: 'I have six one two, five five five, zero one four two. Is that right?' }));
  dg.send(JSON.stringify({ type: 'ConversationText', role: 'user', content: 'yes' }));
  dg.send(JSON.stringify({ type: 'FunctionCallRequest', functions: [{ id: '2', name: 'book', arguments: args, client_side: true }] }));
  const second = await agent.until((m) => m.type === 'FunctionCallResponse' && m.id === '2');
  assert.strictEqual(JSON.parse(second.content).ok, true);
  assert.strictEqual(r.ledger.list().requests.length, 1);
  ws.close();
  r.stop();
});

test('a Spanish caller switches the voice', async () => {
  const r = await rig();
  const dgConn = once(r.dgServer, 'connection');
  const ws = new WebSocket(`ws://127.0.0.1:${r.port}/call`);
  const caller = collector(ws);
  const dg = await dgConn;
  const agent = collector(dg);
  await agent.until((m) => m.type === 'Settings');
  dg.send(JSON.stringify({ type: 'ConversationText', role: 'user', content: 'Hola, quisiera una cita para mi hijo' }));
  const up = await agent.until((m) => m.type === 'UpdateSpeak');
  assert.match(up.speak.provider.model, /-es$/);
  assert.strictEqual((await caller.until((m) => m.type === 'language')).language, 'es');
  ws.close();
  r.stop();
});

test('phone call: signed webhook, one-time stream token, audio both ways, barge in', async () => {
  const PUBLIC_URL = 'https://shop.example';
  const TWILIO_AUTH_TOKEN = 'secret';
  const r = await rig({ PUBLIC_URL, TWILIO_AUTH_TOKEN });
  const post = (signature) => new Promise((resolve) => {
    const body = 'CallSid=CA1&From=%2B16125550142';
    const q = http.request({ port: r.port, host: '127.0.0.1', path: '/twilio/voice', method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(signature ? { 'x-twilio-signature': signature } : {}) } }, async (res) => {
      let t = ''; for await (const c of res) t += c; resolve({ status: res.statusCode, text: t });
    });
    q.end(body);
  });
  assert.strictEqual((await post()).status, 403);
  const data = `${PUBLIC_URL}/twilio/voice${'CallSid'}CA1${'From'}+16125550142`;
  const sig = crypto.createHmac('sha1', TWILIO_AUTH_TOKEN).update(data).digest('base64');
  const hook = await post(sig);
  assert.strictEqual(hook.status, 200);
  const token = hook.text.match(/name="token" value="([a-f0-9]+)"/)[1];
  assert.match(hook.text, /wss:\/\/shop\.example\/twilio\/stream/);

  const bad = new WebSocket(`ws://127.0.0.1:${r.port}/twilio/stream`);
  await once(bad, 'open');
  bad.send(JSON.stringify({ event: 'start', start: { streamSid: 'S0', customParameters: { token: 'wrong' } } }));
  await once(bad, 'close');

  const dgConn = once(r.dgServer, 'connection');
  const tw = new WebSocket(`ws://127.0.0.1:${r.port}/twilio/stream`);
  await once(tw, 'open');
  const heard = collector(tw);
  tw.send(JSON.stringify({ event: 'start', start: { streamSid: 'S1', customParameters: { token } } }));
  const dg = await dgConn;
  const agent = collector(dg);
  const settings = await agent.until((m) => m.type === 'Settings');
  assert.strictEqual(settings.audio.input.encoding, 'mulaw');
  dg.send(JSON.stringify({ type: 'SettingsApplied' }));
  await new Promise((res) => setTimeout(res, 50));
  tw.send(JSON.stringify({ event: 'media', media: { track: 'inbound', payload: Buffer.from('caller').toString('base64') } }));
  const audioIn = await agent.until((m) => m.binary);
  assert.strictEqual(audioIn.binary.toString(), 'caller');
  dg.send(Buffer.from('agent'));
  const audioOut = await heard.until((m) => m.event === 'media');
  assert.strictEqual(Buffer.from(audioOut.media.payload, 'base64').toString(), 'agent');
  dg.send(JSON.stringify({ type: 'UserStartedSpeaking' }));
  assert.strictEqual((await heard.until((m) => m.event === 'clear')).streamSid, 'S1');
  tw.close();
  r.stop();
});

test('page data and browser calls refuse anything coming through a tunnel', async () => {
  const r = await rig();
  const get = (headers) => new Promise((resolve) => { http.get({ port: r.port, host: '127.0.0.1', path: '/api/state', headers }, (res) => { res.resume(); resolve(res.statusCode); }); });
  assert.strictEqual(await get({}), 200);
  assert.strictEqual(await get({ 'x-forwarded-for': '1.2.3.4' }), 403);
  const ws = new WebSocket(`ws://127.0.0.1:${r.port}/call`, { headers: { 'x-forwarded-for': '1.2.3.4' } });
  const err = await once(ws, 'error');
  assert.match(err.message, /403/);
  r.stop();
});

test('validSignature rejects a wrong or missing signature', () => {
  assert.strictEqual(validSignature({ authToken: 't', url: 'u', params: {}, signature: 'AAAA' }), false);
  assert.strictEqual(validSignature({ authToken: '', url: 'u', params: {}, signature: 'AAAA' }), false);
  assert.strictEqual(validSignature({ authToken: 't', url: 'u', params: {}, signature: undefined }), false);
});
