// Speech-to-text factory. Decoupled from the LLM provider because Anthropic has
// no audio API — we transcribe with whatever audio-capable key is available, and
// fall back across providers. Returns { text, provider } or { text:'', error }.
const { pcmToWav } = require('./wav');
const { AUDIO_SAMPLE_RATE } = require('./audio-config');
const { STT_MODELS } = require('./provider-config');
const { validateOfflineConfig, transcribeOffline } = require('./offline-stt');
const { looksLikeHallucination } = require('./transcript-hygiene');

async function transcribeOpenAI(apiKey, wav, model, prompt = '') {
  const OpenAI = require('openai');
  const toFile = OpenAI.toFile || require('openai/uploads').toFile;
  const client = new OpenAI({ apiKey });
  const file = await toFile(wav, 'audio.wav', { type: 'audio/wav' });
  const body = { file, model: model || 'whisper-1' };
  if (prompt) body.prompt = prompt;
  const res = await client.audio.transcriptions.create(body);
  return (res.text || '').trim();
}

async function transcribeGemini(apiKey, wav, model) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const res = await ai.models.generateContent({
    model: model || STT_MODELS.geminiFallback,
    contents: [{ role: 'user', parts: [
      { text: 'Transcribe this audio verbatim. Return only the spoken words with no commentary. If there is no clear speech, return an empty response.' },
      { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }
    ] }]
  });
  return ((res && res.text) || '').trim();
}

function createSTT(settings, { env = process.env, vocab = '', offlineTranscribe = transcribeOffline, openAITranscribe = transcribeOpenAI, geminiTranscribe = transcribeGemini } = {}) {
  const keys = settings.apiKeys || {};
  const chain = [];
  const transcription = settings.transcription || {};
  const fallbackModel = transcription.fallbackModel || settings.sttModel || STT_MODELS.openaiFallback;
  const geminiFallbackModel = transcription.geminiFallbackModel || STT_MODELS.geminiFallback;
  // Initial-prompt seed: explicit vocab wins, otherwise an optional setting.
  const prompt = vocab || transcription.vocabPrompt || '';
  const offline = validateOfflineConfig(env);
  if (transcription.offlineEnabled && offline.ready) {
    chain.push({ p: 'offline', fn: (wav) => offlineTranscribe(wav, { env, language: transcription.language || '', prompt }) });
  }
  const allowCloud = !transcription.offlineEnabled || transcription.offlineCloudFallback === true;
  if (allowCloud && keys.openai) chain.push({ p: 'openai', fn: (wav) => openAITranscribe(keys.openai, wav, fallbackModel, prompt) });
  if (allowCloud && keys.gemini) chain.push({ p: 'gemini', fn: (wav) => geminiTranscribe(keys.gemini, wav, geminiFallbackModel) });

  return {
    available: chain.length > 0,
    providers: chain.map((c) => c.p),
    offlineError: transcription.offlineEnabled && !offline.ready ? offline.error : '',
    async transcribe(pcm) {
      if (!chain.length || !pcm || pcm.length < 3200) return { text: '' };
      const wav = pcmToWav(pcm, AUDIO_SAMPLE_RATE, 1);
      let lastErr = null;
      for (const c of chain) {
        try {
          const text = await c.fn(wav);
          // Drop whisper silence artifacts before they reach the transcript;
          // a phantom "Thank you for watching." row is worse than no row.
          if (looksLikeHallucination(text)) return { text: '', provider: c.p };
          return { text, provider: c.p };
        } catch (e) {
          lastErr = { status: e && e.status, code: e && e.code, message: (e && e.message) || String(e), provider: c.p };
          if (e && e.code === 'offline_cancelled') return { text: '', error: lastErr };
        }
      }
      return { text: '', error: lastErr };
    }
  };
}

module.exports = { createSTT };
