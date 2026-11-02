// Real phone calls. Twilio posts to /twilio/voice, we answer with TwiML that
// opens a media stream, and this adapter makes the stream look like the socket
// CallSession expects.
const crypto = require('crypto');
const { EventEmitter } = require('events');
const WebSocket = require('ws');

// https://www.twilio.com/docs/usage/webhooks/webhooks-security
function validSignature({ authToken, url, params, signature }) {
  if (!authToken || !signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = crypto.createHmac('sha1', authToken).update(data).digest();
  const given = Buffer.from(String(signature), 'base64');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const streamTwiml = (wsUrl, token) => `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xml(wsUrl)}"><Parameter name="token" value="${xml(token)}"/></Stream></Connect></Response>`;
const sorryTwiml = (message) => `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${xml(message)}</Say><Hangup/></Response>`;

// One-time tokens: only a call that came through a signed webhook gets a stream.
function createTokens(ttlMs = 60000, now = Date.now) {
  const live = new Map();
  return {
    issue() {
      const t = crypto.randomBytes(18).toString('hex');
      live.set(t, now() + ttlMs);
      return t;
    },
    redeem(t) {
      const until = live.get(t);
      live.delete(t);
      return !!until && until >= now();
    },
  };
}

// Looks like a ws socket to CallSession: 'message' events carry mu-law audio,
// send(Buffer) plays audio, and send(JSON) is an event the caller never hears.
class TwilioClient extends EventEmitter {
  constructor(ws) {
    super();
    this.ws = ws;
    this.streamSid = null;
    ws.on('close', () => this.emit('close'));
  }

  get readyState() { return this.ws.readyState; }

  start(streamSid) { this.streamSid = streamSid; }

  receive(msg) {
    if (msg.event === 'media' && msg.media && msg.media.track !== 'outbound') this.emit('message', Buffer.from(msg.media.payload, 'base64'), true);
    if (msg.event === 'stop') this.emit('close');
  }

  send(data, opts) {
    if (this.ws.readyState !== WebSocket.OPEN || !this.streamSid) return;
    if (opts && opts.binary) {
      this.ws.send(JSON.stringify({ event: 'media', streamSid: this.streamSid, media: { payload: Buffer.from(data).toString('base64') } }));
      return;
    }
    const ev = JSON.parse(data);
    if (ev.type === 'UserStartedSpeaking') this.ws.send(JSON.stringify({ event: 'clear', streamSid: this.streamSid })); // barge in
  }

  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

module.exports = { validSignature, streamTwiml, sorryTwiml, createTokens, TwilioClient };
