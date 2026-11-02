const $ = (id) => document.getElementById(id);
let ws, micCtx, playCtx, micStream, playHead = 0, sources = [];

function rows(parent, items, empty) {
  parent.textContent = '';
  if (!items.length) { parent.textContent = empty; return; }
  for (const it of items) {
    const d = document.createElement('div');
    d.className = `row ${it.cls || ''}`;
    d.textContent = it.text;
    parent.appendChild(d);
  }
}

function renderShop(shop) {
  if (!shop) return;
  const f = (k) => (shop.facts[k] ? shop.facts[k].value : null);
  $('title').textContent = `${f('name') || shop.shop_id} voice concierge`;
  rows($('sources'), shop.sources.map((s) => ({
    cls: s.ok ? 'ok' : 'bad',
    text: `${s.ok ? 'Read' : 'Failed'}: ${s.label}${s.ok ? ` at ${new Date(s.fetched_at).toLocaleTimeString()}` : ` (${s.error})`}`,
  })), 'No sources.');
  const money = (s) => (s.price_usd != null ? `$${s.price_usd}${s.price_is_starting ? '+' : ''}` : 'price unknown');
  const mins = (s) => (s.duration_min != null ? `${s.duration_min} min` : 'length unknown');
  rows($('facts'), [
    ...Object.entries(shop.facts).filter(([, v]) => typeof v.value !== 'object').map(([k, v]) => ({ text: `${k}: ${v.value}  [${v.source}]` })),
    ...shop.services.map((s) => ({ text: `Menu: ${s.name}, ${money(s)}, ${mins(s)}` })),
    ...shop.addons.map((a) => ({ text: `Add-on: ${a.name}, $${a.price_usd}` })),
    ...shop.barbers.flatMap((b) => [
      { text: `Barber: ${b.name} (${b.role}), calendar: ${b.calendar}` },
      ...(b.services || []).map((s) => ({ text: `  ${b.name}: ${s.name}, ${money(s)}, ${mins(s)}` })),
    ]),
    ...shop.conflicts.map((c) => ({ cls: 'bad', text: `Sources disagree on ${c.fact}: using "${c.kept.value}" over "${c.other.value}"` })),
  ], 'Nothing read yet.');
}

async function loadShop(refresh) {
  const res = await fetch(refresh ? '/api/shop/refresh' : '/api/shop', { method: refresh ? 'POST' : 'GET' });
  renderShop(await res.json());
}

async function refreshState() {
  const st = await (await fetch('/api/state')).json();
  rows($('requests'), [
    ...st.requests.map((r) => ({ text: `${r.code} ${r.status}: ${r.what} (${r.customer_name || 'caller'})` })),
    ...st.handoffs.map((h) => ({ text: `${h.urgent ? 'Urgent handoff' : 'Handoff'}: ${h.summary}` })),
  ], 'None yet.');
  rows($('texts'), st.texts.map((t) => ({ text: `[${t.status}] to ${t.to || 'nobody set'}: ${t.body}` })), st.texts_live ? 'None yet.' : 'None yet. Twilio is not set up, so texts are shown here and not sent.');
}

function add(role, text) {
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.textContent = role === 'sys' || !window.Digits ? text : window.Digits.toDisplay(text);
  el.title = text;
  $('transcript').appendChild(el);
  $('transcript').scrollTop = 1e9;
}

const setStatus = (s) => { $('status').textContent = s; };

function playPcm(buf) {
  const pcm = new Int16Array(buf);
  const audio = playCtx.createBuffer(1, pcm.length, 24000);
  const ch = audio.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
  const src = playCtx.createBufferSource();
  src.buffer = audio;
  src.connect(playCtx.destination);
  playHead = Math.max(playHead, playCtx.currentTime + 0.02);
  src.start(playHead);
  playHead += audio.duration;
  sources.push(src);
  src.onended = () => { sources = sources.filter((s) => s !== src); };
}

function stopPlayback() {
  for (const s of sources) { try { s.stop(); } catch (e) { /* already stopped */ } }
  sources = [];
  playHead = 0;
}

function onEvent(msg) {
  switch (msg.type) {
    case 'status':
      if (msg.status === 'live') setStatus('Live, go ahead and talk');
      if (msg.status === 'ended') endCall();
      break;
    case 'ConversationText': add(msg.role, msg.content); break;
    case 'UserStartedSpeaking': stopPlayback(); setStatus('Listening'); break;
    case 'AgentThinking': setStatus('Thinking'); break;
    case 'AgentStartedSpeaking': setStatus('Agent speaking'); break;
    case 'AgentAudioDone': setStatus('Live, go ahead and talk'); break;
    case 'language': add('sys', `Voice switched to ${msg.language === 'es' ? 'Spanish' : 'English'}`); break;
    case 'tool': {
      const el = document.createElement('div');
      el.className = 'row';
      el.textContent = `${msg.name}(${JSON.stringify(msg.arguments)})\n=> ${JSON.stringify(msg.result).slice(0, 400)}`;
      if ($('tools').querySelector('.hint')) $('tools').textContent = '';
      $('tools').prepend(el);
      refreshState();
      break;
    }
    case 'Error': add('sys', `Error: ${msg.description || msg.code}`); break;
    case 'Warning': add('sys', `Warning: ${msg.description}`); break;
    default: break;
  }
}

async function startCall() {
  $('transcript').textContent = '';
  setStatus('Connecting');
  micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  micCtx = new AudioContext();
  playCtx = new AudioContext({ sampleRate: 24000 });
  await micCtx.audioWorklet.addModule('mic-worklet.js');
  const node = new AudioWorkletNode(micCtx, 'mic-processor');
  micCtx.createMediaStreamSource(micStream).connect(node);
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/call`);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (e) => (typeof e.data === 'string' ? onEvent(JSON.parse(e.data)) : playPcm(e.data));
  ws.onclose = () => endCall();
  node.port.onmessage = (e) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(e.data); };
  $('call').textContent = 'Hang up';
}

function endCall() {
  if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: 'hangup' })); ws.close(); }
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (micCtx) micCtx.close();
  stopPlayback();
  if (playCtx) playCtx.close();
  micStream = micCtx = playCtx = ws = null;
  $('call').textContent = 'Start call';
  setStatus('Call ended');
  refreshState();
}

$('call').onclick = () => (ws ? endCall() : startCall().catch((e) => { add('sys', `Could not start: ${e.message}`); endCall(); }));
$('refresh').onclick = () => loadShop(true);
loadShop(false);
setInterval(() => loadShop(false), 5000);
refreshState();
