// One call: bridges a client socket (browser, or the Twilio adapter) to
// Deepgram's agent socket. Binary frames are audio. JSON frames are events for
// the page. The Deepgram key only lives on this server.
const WebSocket = require('ws');
const { buildSettings } = require('./settings');
const { createTools, normPhone } = require('./tools');
const { localParts } = require('./time');
const lang = require('./languages');
const { phoneReadBack, phoneInWords } = require('./readback');

const GOODBYE = /\b(good ?bye|bye|have a (great|good|nice|wonderful)|take care|see you|thanks for calling|adi[oó]s|hasta (luego|pronto)|que tenga|cu[ií]dese|gracias por llamar)\b/i;
const noDashes = (t) => String(t).replace(/\s*[–—]\s*/g, ', ').replace(/,\s*([,.?!])/g, '$1');
const DEFAULT_AGENT_URL = 'wss://agent.deepgram.com/v1/agent/converse';
const FORWARD = new Set(['Welcome', 'SettingsApplied', 'ConversationText', 'UserStartedSpeaking', 'AgentThinking', 'AgentStartedSpeaking', 'AgentAudioDone', 'Error', 'Warning', 'FunctionCallCancelled']);
const CHECK_IN = {
  en: ['Are you still there? Take your time.', "I'll let you go for now. Call back anytime. Bye!"],
  es: ['¿Sigue ahí? Tómese su tiempo.', 'Lo dejo por ahora. Llámenos cuando guste. ¡Adiós!'],
};
const safeParse = (s) => { try { return JSON.parse(s); } catch { return {}; } };

let nextId = 1;

class CallSession {
  constructor({ client, shop, ledger, sms, apiKey, agentUrl, channel = 'browser', silenceMs = 15000, keepAliveMs = 8000, clock = () => new Date(), langConfig, log = () => {} }) {
    this.id = String(nextId++);
    Object.assign(this, { client, shop, log, silenceMs });
    this.ready = false;
    this.closed = false;
    this.strikes = 0;
    this.pendingEnd = false;
    this.speaking = false;
    this.cancelled = new Set();
    this.history = [];
    this.language = 'en';
    this.langConfig = langConfig || lang.config();
    this.tools = createTools({ shop, ledger, sms, clock, getLanguage: () => this.language });

    this.toClient({ type: 'session', session_id: this.id, shop: shop.spoken_name });
    this.dg = new WebSocket(agentUrl || DEFAULT_AGENT_URL, { headers: { Authorization: `Token ${apiKey}` } });
    this.dg.on('open', () => {
      this.sendDg(buildSettings({ shop, channel, now: localParts(clock(), shop.timezone), langConfig: this.langConfig }));
      this.keepAlive = setInterval(() => this.sendDg({ type: 'KeepAlive' }), keepAliveMs);
    });
    this.dg.on('message', (data, isBinary) => this.onDeepgram(data, isBinary));
    this.dg.on('unexpected-response', (_q, res) => {
      this.toClient({ type: 'Error', code: `HTTP_${res.statusCode}`, description: res.statusCode === 401 ? 'Deepgram rejected the API key.' : `Deepgram returned HTTP ${res.statusCode}.` });
      this.close();
    });
    this.dg.on('error', (e) => { this.toClient({ type: 'Error', code: 'UPSTREAM', description: e.message }); this.close(); });
    this.dg.on('close', () => this.close());

    client.on('message', (data, isBinary) => {
      if (isBinary) { if (this.ready && this.dg.readyState === WebSocket.OPEN) this.dg.send(data); return; }
      const msg = safeParse(data);
      if (msg.type === 'hangup') this.close();
      if (msg.type === 'text' && typeof msg.content === 'string' && msg.content.trim()) { // typed caller, for tests
        this.resetSilence();
        this.sendDg({ type: 'InjectUserMessage', content: msg.content.trim().slice(0, 500) });
      }
    });
    client.on('close', () => this.close());
  }

  toClient(obj) { if (this.client.readyState === WebSocket.OPEN) this.client.send(JSON.stringify(obj)); }
  sendDg(obj) { if (this.dg.readyState === WebSocket.OPEN) this.dg.send(JSON.stringify(obj)); }

  onDeepgram(data, isBinary) {
    if (isBinary) { if (this.client.readyState === WebSocket.OPEN) this.client.send(data, { binary: true }); return; }
    const msg = safeParse(data.toString());
    if (msg.type === 'ConversationText' && msg.role === 'assistant') msg.content = noDashes(msg.content || '');
    if (FORWARD.has(msg.type)) this.toClient(msg);
    switch (msg.type) {
      case 'SettingsApplied': this.ready = true; this.toClient({ type: 'status', status: 'live' }); break;
      case 'UserStartedSpeaking': this.resetSilence(); break;
      case 'ConversationText':
        if (typeof msg.content === 'string') this.history.push({ role: msg.role, content: msg.content });
        if (msg.role === 'user') {
          this.resetSilence();
          const l = lang.detectLanguage(msg);
          if (l) this.switchLanguage(l);
        }
        break;
      case 'AgentStartedSpeaking': this.speaking = true; this.clearSilence(); break;
      case 'AgentAudioDone':
        this.speaking = false;
        if (this.pendingEnd) { setTimeout(() => this.close(), 1500); break; } // let the goodbye finish
        this.armSilence();
        break;
      case 'FunctionCallCancelled': for (const f of msg.functions || []) this.cancelled.add(f.id); break;
      case 'FunctionCallRequest': this.onFunctionCall(msg); break;
      default: break;
    }
  }

  switchLanguage(l) {
    if (l === this.language) return;
    this.language = l;
    this.sendDg({ type: 'UpdateSpeak', speak: lang.speakFor(l, this.langConfig) });
    this.toClient({ type: 'language', language: l });
  }

  // A number gets stored only after the agent said it back and the caller answered.
  readBackGate(fn) {
    if (!['book', 'request_approval'].includes(fn.name)) return null;
    const phone = normPhone(safeParse(fn.arguments).customer_phone);
    if (!phone) return null; // the tool rejects a bad number itself
    const r = phoneReadBack(this.history, phone);
    if (r.ok) return null;
    const groups = `${phone.slice(0, 3)}, ${phone.slice(3, 6)}, ${phone.slice(6)}`;
    const words = phoneInWords(phone, this.language);
    const say = {
      NOT_CONFIRMED: 'Nothing was sent yet. Ask if that number is right and wait for the answer, then call this again.',
      NOT_IN_WORDS: `Nothing was sent yet. You said the number as numerals, which a voice reads as one big number. Say it again in words, one digit at a time, exactly like this: "${words}". Ask if it is right, then call this again after they confirm.`,
      NOT_READ_BACK: `Nothing was sent yet. Read the number back in words, one digit at a time, exactly like this: "${words}", and ask if it is right. Call this again after they confirm.`,
    }[r.reason];
    return { ok: false, error: 'READ_BACK_PHONE_FIRST', phone_groups: groups, say_exactly: words, say };
  }

  // "First available" has to be the caller's choice. Cekura caught the agent
  // booking first available without ever asking, so the caller's preferred
  // barber was never heard.
  barberGate(fn) {
    if (fn.name !== 'book') return null;
    const barber = String(safeParse(fn.arguments).barber || '').toLowerCase();
    if (!/first|any|cualquier|primer/.test(barber)) return null;
    const asked = this.history.some((h) => h.role === 'assistant' && /barber|barbero|preferen|anyone|cualquier|con qui[eé]n|who would you like/i.test(h.content));
    const callerSaid = this.history.some((h) => h.role === 'user' && /first available|anyone|any barber|no preference|doesn'?t matter|cualquier|el primero|la primera|no importa/i.test(h.content));
    return asked || callerSaid ? null : { ok: false, error: 'ASK_BARBER_FIRST', say: 'Nothing was sent yet. Ask if they have a barber in mind, or if first available is fine. Call this again with their answer.' };
  }

  // Moving or cancelling needs the caller to answer after the agent has spoken.
  confirmGate(fn) {
    if (!['reschedule', 'cancel'].includes(fn.name)) return null;
    const lastAgent = this.history.map((h) => h.role).lastIndexOf('assistant');
    const answered = lastAgent >= 0 && this.history.slice(lastAgent + 1).some((h) => h.role === 'user');
    return answered ? null : { ok: false, error: 'CONFIRM_FIRST', say: 'Nothing was sent yet. Tell the caller what will change and ask if that is right. Call this again after they say yes.' };
  }

  onFunctionCall(msg) {
    for (const fn of msg.functions || []) {
      if (fn.client_side === false || this.cancelled.has(fn.id)) continue;
      const result = this.barberGate(fn) || this.readBackGate(fn) || this.confirmGate(fn) || this.tools.run(fn.name, fn.arguments);
      if (fn.name === 'set_language' && result.ok) this.switchLanguage(result.language);
      if (fn.name === 'end_call') {
        this.pendingEnd = true;
        // The goodbye usually finishes before end_call arrives. Answering the call
        // would make the agent say goodbye again, so hang up instead, but only if
        // a goodbye was actually said: Cekura caught a call that ended with none.
        if (!this.speaking && this.saidGoodbye()) {
          this.toClient({ type: 'tool', name: fn.name, arguments: safeParse(fn.arguments), result });
          // If the goodbye starts after all, AgentAudioDone closes the call instead.
          setTimeout(() => { if (!this.speaking) this.close(); }, 1500);
          continue;
        }
      }
      if (this.language !== 'en') result.reply_language = lang.NAMES[this.language];
      this.toClient({ type: 'tool', name: fn.name, arguments: safeParse(fn.arguments), result });
      this.sendDg({ type: 'FunctionCallResponse', id: fn.id, name: fn.name, content: JSON.stringify(result) });
    }
  }

  saidGoodbye() {
    const last = [...this.history].reverse().find((h) => h.role === 'assistant');
    return !!last && GOODBYE.test(last.content);
  }

  armSilence() {
    this.clearSilence();
    this.silenceTimer = setTimeout(() => {
      this.strikes += 1;
      const [checkIn, bye] = CHECK_IN[this.language];
      if (this.strikes > 1) this.pendingEnd = true;
      this.sendDg({ type: 'InjectAgentMessage', message: this.strikes === 1 ? checkIn : bye });
    }, this.silenceMs);
  }

  resetSilence() { this.strikes = 0; this.clearSilence(); }
  clearSilence() { clearTimeout(this.silenceTimer); }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.clearSilence();
    clearInterval(this.keepAlive);
    try { this.dg.close(); } catch { /* already gone */ }
    this.toClient({ type: 'status', status: 'ended' });
    try { this.client.close(); } catch { /* already gone */ }
    this.log(`call ${this.id} closed`);
  }
}

module.exports = { CallSession, noDashes };
