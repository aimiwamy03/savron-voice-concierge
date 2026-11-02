// Serves the demo page, the live shop data, and the call sockets for one shop.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { createShopInfo } = require('./src/live/shopinfo');
const { createLedger } = require('./src/tools');
const { createSms } = require('./src/sms');
const { CallSession } = require('./src/session');
const twilio = require('./src/twilio');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const SHOP_ID = /^[a-z0-9-]+$/;

function loadShopConfig(id) {
  if (!SHOP_ID.test(id)) throw new Error(`Bad shop id: ${id}`);
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'shops', `${id}.json`), 'utf8'));
}

// SHOP picks the config. With a single file in shops/, that one is the default.
function defaultShopId(env = process.env) {
  if (env.SHOP) return env.SHOP;
  const ids = fs.readdirSync(path.join(__dirname, 'shops')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  if (ids.length !== 1) throw new Error(`Set SHOP to one of: ${ids.join(', ')}`);
  return ids[0];
}

// A tunnel to this machine still connects from loopback, but it adds forwarding
// headers. The page and its data hold callers' numbers, so they stay local.
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !req.headers['x-forwarded-for'] && !req.headers['x-forwarded-host'];

function createServer({ config, env = process.env, shopInfo, sms, agentUrl, clock, log = console.log } = {}) {
  const apiKey = env.DEEPGRAM_API_KEY;
  const info = shopInfo || createShopInfo(config, { ttlMs: Number(env.SHOP_INFO_TTL_MIN || 5) * 60000 });
  const ledger = createLedger();
  const texts = sms || createSms(env, { log });
  const tokens = twilio.createTokens();
  const publicDir = path.join(__dirname, 'public');
  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const twiml = (res, body) => { res.writeHead(200, { 'content-type': 'text/xml' }); res.end(body); };

  async function onVoiceWebhook(req, res) {
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 100000) return json(res, 413, {}); }
    const params = Object.fromEntries(new URLSearchParams(raw));
    const url = `${env.PUBLIC_URL}/twilio/voice`;
    if (!twilio.validSignature({ authToken: env.TWILIO_AUTH_TOKEN, url, params, signature: req.headers['x-twilio-signature'] })) return json(res, 403, { error: 'Bad signature' });
    const shop = await info.forCall();
    if (!apiKey || !shop || !shop.spoken_name) return twiml(res, twilio.sorryTwiml('Sorry, our assistant is not available right now. Please call back soon.'));
    return twiml(res, twilio.streamTwiml(`${env.PUBLIC_URL.replace(/^http/, 'ws')}/twilio/stream`, tokens.issue()));
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/twilio/voice') {
      return onVoiceWebhook(req, res).catch((e) => { log(`voice webhook failed: ${e.message}`); if (!res.headersSent) json(res, 500, {}); });
    }
    if (!isLocal(req)) return json(res, 403, { error: 'Local only' });
    if (url.pathname === '/api/shop') return json(res, 200, info.current());
    if (req.method === 'POST' && url.pathname === '/api/shop/refresh') return info.refresh().then((s) => json(res, 200, s));
    if (url.pathname === '/api/state') return json(res, 200, { ...ledger.list(), texts: texts.outbox, texts_live: texts.live, has_key: !!apiKey });
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const full = path.join(publicDir, path.normalize(file));
    if (!full.startsWith(publicDir + path.sep) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
    return fs.createReadStream(full).pipe(res);
  });

  async function startBrowserCall(ws) {
    if (!apiKey) {
      ws.send(JSON.stringify({ type: 'Error', code: 'NO_KEY', description: 'DEEPGRAM_API_KEY is not set on the server.' }));
      return ws.close();
    }
    const shop = await info.forCall();
    if (!shop || !shop.spoken_name) {
      ws.send(JSON.stringify({ type: 'Error', code: 'NO_SHOP_DATA', description: 'No shop source could be read.' }));
      return ws.close();
    }
    return new CallSession({ client: ws, shop, ledger, sms: texts, apiKey, agentUrl, clock, log });
  }

  function startPhoneCall(ws) {
    const client = new twilio.TwilioClient(ws);
    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.event === 'start') {
        const token = msg.start && msg.start.customParameters && msg.start.customParameters.token;
        if (!tokens.redeem(token)) return ws.close();
        client.start(msg.start.streamSid);
        const shop = await info.forCall();
        return new CallSession({ client, shop, ledger, sms: texts, apiKey, agentUrl, clock, log, channel: 'phone' });
      }
      return client.receive(msg);
    });
  }

  // Sockets are matched by hand so each one has its own access rule.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const route = pathname === '/twilio/stream' ? startPhoneCall : pathname === '/call' && isLocal(req) ? startBrowserCall : null;
    if (!route) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
    return wss.handleUpgrade(req, socket, head, (ws) => {
      Promise.resolve(route(ws)).catch((e) => { log(`call failed to start: ${e.message}`); ws.close(); });
    });
  });

  return { server, info, ledger, texts };
}

if (require.main === module) {
  const config = loadShopConfig(defaultShopId());
  const { server, info } = createServer({ config });
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  info.refresh().then((s) => {
    for (const src of s.sources) console.log(`${src.ok ? 'ok  ' : 'FAIL'} ${src.label}${src.ok ? '' : ` (${src.error})`}`);
  });
  server.listen(port, host, () => {
    console.log(`Concierge for "${config.id}" on http://${host}:${port}`);
    if (!process.env.DEEPGRAM_API_KEY) console.log('DEEPGRAM_API_KEY is not set, so calls will be refused until you add it.');
  });
}

module.exports = { createServer, loadShopConfig, defaultShopId };
