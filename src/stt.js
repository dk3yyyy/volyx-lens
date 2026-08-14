// Speech-to-text factory. Decoupled from the LLM provider because Anthropic has
// no audio API — we transcribe with whatever audio-capable key is available, and
// fall back across providers. Returns { text, provider } or { text:'', error }.
const { pcmToWav } = require('./wav');
const { AUDIO_SAMPLE_RATE } = require('./audio-config');
const { STT_MODELS } = require('./provider-config');
const { validateOfflineConfig, transcribeOffline } = require('./offline-stt');
const { WhisperSidecar } = require('./whisper-sidecar');
const { looksLikeHallucination } = require('./transcript-hygiene');

let sidecar = null; // lazily initialized, fully-started WhisperSidecar instance
let starting = null; // in-flight startup promise shared by concurrent requests

// Sidecar mode is strictly opt-in via VOLYX_LENS_WHISPER_SIDECAR env var
function shouldUseSidecar(env) {
  return !!env.VOLYX_LENS_WHISPER_SIDECAR;
}

// Use the local whisper.cpp sidecar when offlineEnabled is on and the
// VOLYX_LENS_WHISPER_SIDECAR opt-in is not active. This is the new first-class
// "Local (whisper.cpp)" provider.
function shouldUseLocalWhisper(transcription, env) {
  return !!(
    transcription.offlineEnabled &&
    !env.VOLYX_LENS_WHISPER_SIDECAR &&
    !!transcription.whisperModel
  );
}

async function transcribeViaLocalWhisper(wav, env, language, whisperModel) {
  // Initialize sidecar if not already running. Uses the whisperModel from
  // settings (falls back to 'base.en'). The sidecar downloads the model in-app
  // if not already cached, transcribes in-memory (no temp files), and supports
  // a shared inference queue for You/Them channels.
  if (!sidecar || !sidecar.running) {
    if (!starting) {
      const factory =
        sidecarFactory || ((id) => new WhisperSidecar({ modelId: id }));
      const instance = factory(whisperModel);
      starting = instance.start().then(() => {
        sidecar = instance;
        starting = null;
        return instance;
      }).catch((error) => {
        starting = null;
        throw error;
      });
    }
    await starting;
  }

  // Queue the WAV for in-memory transcription (no temp files on disk)
  const result = await sidecar.queueYou(wav);
  return (result.text || '').trim();
}

// Reset the lazily initialized sidecar (config changes, shutdown, tests)
function resetSidecar() {
  sidecar = null;
  starting = null;
}

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

// Speech-to-text factory. Decoupled from the LLM provider because Anthropic has
// no audio API — we transcribe with whatever audio-capable key is available, and
// fall back across providers. Returns { text, provider } or { text:'', error }.
function createSTT(settings, { env = process.env, vocab = '', offlineTranscribe = transcribeOffline, openAITranscribe = transcribeOpenAI, geminiTranscribe = transcribeGemini, sidecarFactory = (modelId) => new WhisperSidecar({ modelId }) } = {}) {
  const keys = settings.apiKeys || {};
  const chain = [];
  const transcription = settings.transcription || {};
  const fallbackModel = transcription.fallbackModel || settings.sttModel || STT_MODELS.openaiFallback;
  const geminiFallbackModel = transcription.geminiFallbackModel || STT_MODELS.geminiFallback;
  // Initial-prompt seed: explicit vocab wins, otherwise an optional setting.
  const prompt = vocab || transcription.vocabPrompt || '';
  const offline = validateOfflineConfig(env);
  // Sidecar mode: strictly opt-in via VOLYX_LENS_WHISPER_SIDECAR env var
  const useSidecar = shouldUseSidecar(env);
  if (useSidecar) {
    chain.push({ p: 'sidecar', fn: (wav) => transcribeViaSidecar(wav, env, vocab, sidecarFactory) });
  }
  // Local whisper.cpp: first-class "Local (whisper.cpp)" provider, enabled when
  // offlineEnabled is on and the VOLYX_LENS_WHISPER_SIDECAR opt-in is not active.
  // The model is selected from the Settings UI (base.en, small, medium, large-v3,
  // quantized variants, etc.) and downloaded in-app if not already cached.
  const useLocalWhisper = shouldUseLocalWhisper(transcription, env);
  if (useLocalWhisper) {
    chain.push({ p: 'local-whisper', fn: (wav) => transcribeViaLocalWhisper(wav, env, transcription.language || '', transcription.whisperModel) });
  }
  if (transcription.offlineEnabled && offline.ready) {
    chain.push({ p: 'offline', fn: (wav) => offlineTranscribe(wav, { env, language: transcription.language || '', prompt }) });
  }
  const allowCloud = !transcription.offlineEnabled || transcription.offlineCloudFallback === true;
  if (allowCloud && keys.openai) chain.push({ p: 'openai', fn: (wav) => openAITranscribe(keys.openai, wav, fallbackModel, prompt) });
  if (allowCloud && keys.gemini) chain.push({ p: 'gemini', fn: (wav) => geminiTranscribe(keys.gemini, wav, geminiFallbackModel) });

  // Determine offline error: show if offlineEnabled is on but no path is available.
  // Paths available: sidecar (opt-in via env), local-whisper (in-app model picker),
  // CLI (VOLYX_LENS_WHISPER_CLI + VOLYX_LENS_WHISPER_MODEL env vars).
  const hasAnyOfflinePath =
    useSidecar || useLocalWhisper || (transcription.offlineEnabled && offline.ready);
  const offlineError = transcription.offlineEnabled && !hasAnyOfflinePath ? offline.error : '';

  return {
    available: chain.length > 0,
    providers: chain.map((c) => c.p),
    offlineError,
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

module.exports = { createSTT, resetSidecar };
