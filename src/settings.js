// Builds the Deepgram Voice Agent "Settings" message (wss://agent.deepgram.com/v1/agent/converse).
// Shape checked against spec/voice-agent-asyncapi.md by scripts/validate-settings.js.
const { definitions } = require('./tools');
const { buildPrompt, buildGreeting } = require('./prompt');
const lang = require('./languages');

const AUDIO = {
  browser: {
    input: { encoding: 'linear16', sample_rate: 16000 },
    output: { encoding: 'linear16', sample_rate: 24000, container: 'none' },
  },
  // Twilio media streams carry 8 kHz mu-law both ways.
  phone: {
    input: { encoding: 'mulaw', sample_rate: 8000 },
    output: { encoding: 'mulaw', sample_rate: 8000, container: 'none' },
  },
};

function buildSettings({ shop, now, channel = 'browser', langConfig, llmModel }) {
  const cfg = langConfig || lang.config();
  const keyterms = [shop.spoken_name, ...shop.barbers.map((b) => b.name.split(' ')[0]), ...shop.services.map((s) => s.name)].filter(Boolean).slice(0, 40);
  return {
    type: 'Settings',
    tags: ['voice-concierge', shop.shop_id],
    audio: AUDIO[channel],
    agent: {
      listen: { provider: lang.listenProvider(keyterms) },
      think: {
        provider: { type: 'open_ai', model: llmModel || process.env.LLM_MODEL || 'gpt-4.1-mini', temperature: 0.4 },
        prompt: buildPrompt(shop, now),
        functions: definitions, // no endpoint means our server runs them
      },
      speak: lang.speakFor('en', cfg),
      greeting: buildGreeting(shop),
    },
  };
}

module.exports = { buildSettings, AUDIO };
