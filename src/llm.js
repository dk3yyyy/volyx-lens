// LLM factory — OpenAI / Anthropic / Gemini / Azure Foundry / OpenAI-compatible providers (DeepSeek, Groq, OpenRouter, ...).
// stream({ system, turns:[{role,text}], imageDataUrl?, imageDataUrls?, maxTokens, onToken }) -> Promise<fullText>
const { resolveProvider } = require('./provider-config');

function stripDataUrl(dataUrl) {
  const m = /^data:(.+?);base64,(.*)$/s.exec(dataUrl || '');
  return m ? { mime: m[1], b64: m[2] } : null;
}

function collectImageDataUrls(imageDataUrls, imageDataUrl) {
  const values = Array.isArray(imageDataUrls) ? imageDataUrls : (imageDataUrl ? [imageDataUrl] : []);
  return values.filter((value) => typeof value === 'string' && stripDataUrl(value));
}

function buildOpenAIMessages(system, turns, imageDataUrls) {
  const messages = [{ role: 'system', content: system }];
  turns.forEach((turn, index) => {
    const last = index === turns.length - 1;
    if (last && imageDataUrls.length && turn.role === 'user') {
      messages.push({ role: 'user', content: [
        { type: 'text', text: turn.text },
        ...imageDataUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
      ] });
    } else {
      messages.push({ role: turn.role, content: turn.text });
    }
  });
  return messages;
}

async function streamOpenAICompatible({
  OpenAI,
  clientOptions,
  model,
  system,
  turns,
  imageDataUrl,
  imageDataUrls,
  maxTokens,
  tokenLimitParameter,
  extraBody,
  onToken,
  onFinish,
  signal,
}) {
  const client = new OpenAI(clientOptions);
  const images = collectImageDataUrls(imageDataUrls, imageDataUrl);
  const messages = buildOpenAIMessages(system, turns, images);
  const baseRequest = { model, messages, stream: true, ...(extraBody || {}) };
  let activeTokenParameter = tokenLimitParameter || 'max_tokens';
  let stream;
  try {
    stream = await client.chat.completions.create({
      ...baseRequest,
      [activeTokenParameter]: maxTokens,
    }, { signal });
  } catch (error) {
    if (signal && signal.aborted) throw error;
    const alternate = activeTokenParameter === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
    const message = (error && error.message) || '';
    const incompatible = error && error.status === 400 &&
      /unsupported parameter/i.test(message) &&
      message.includes(activeTokenParameter) &&
      message.includes(alternate);
    if (!incompatible) throw error;
    activeTokenParameter = alternate;
    stream = await client.chat.completions.create({
      ...baseRequest,
      [activeTokenParameter]: maxTokens,
    }, { signal });
  }
  let full = '';
  let finishReason = null;
  for await (const part of stream) {
    const choice = part.choices && part.choices[0];
    if (choice && choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice && choice.delta && choice.delta.content;
    if (delta) { full += delta; onToken(delta); }
  }
  if (typeof onFinish === 'function') onFinish({ reason: finishReason });
  return full;
}

async function streamAnthropic({ Anthropic, apiKey, model, system, turns, imageDataUrl, imageDataUrls, maxTokens, onToken, onFinish, signal }) {
  const client = new Anthropic({ apiKey });
  const images = collectImageDataUrls(imageDataUrls, imageDataUrl);
  const messages = turns.map((turn, index) => {
    const last = index === turns.length - 1;
    if (last && images.length && turn.role === 'user') {
      const content = [];
      for (const dataUrl of images) {
        const image = stripDataUrl(dataUrl);
        if (image) content.push({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.b64 } });
      }
      content.push({ type: 'text', text: turn.text });
      return { role: 'user', content };
    }
    return { role: turn.role, content: turn.text };
  });
  const stream = await client.messages.create({ model, max_tokens: maxTokens, system, messages, stream: true }, { signal });
  let full = '';
  let stopReason = null;
  for await (const event of stream) {
    if (event.type === 'message_delta' && event.delta && event.delta.stop_reason) stopReason = event.delta.stop_reason;
    if (event.type === 'content_block_delta' && event.delta && event.delta.type === 'text_delta') {
      full += event.delta.text;
      onToken(event.delta.text);
    }
  }
  if (typeof onFinish === 'function') onFinish({ reason: stopReason });
  return full;
}

// Gemini 3.x counts internal "thinking" tokens against maxOutputTokens, so a
// fixed cap can be consumed by reasoning and leave the visible answer cut off.
// Give the cap headroom, and use the lowest thinking level on the fast tier
// where latency matters more than depth.
const GEMINI_THINKING_HEADROOM = { fast: 1024, smart: 4096 };

async function streamGemini({ GoogleGenAI, apiKey, model, system, turns, imageDataUrl, imageDataUrls, maxTokens, thinking = false, onToken, onFinish, signal }) {
  const ai = new GoogleGenAI({ apiKey });
  const images = collectImageDataUrls(imageDataUrls, imageDataUrl);
  const contents = turns.map((turn, index) => {
    const last = index === turns.length - 1;
    const parts = [{ text: turn.text }];
    if (last && images.length && turn.role === 'user') {
      for (const dataUrl of images) {
        const image = stripDataUrl(dataUrl);
        if (image) parts.push({ inlineData: { mimeType: image.mime, data: image.b64 } });
      }
    }
    return { role: turn.role === 'assistant' ? 'model' : 'user', parts };
  });
  const config = {
    systemInstruction: system,
    maxOutputTokens: maxTokens + (thinking ? GEMINI_THINKING_HEADROOM.smart : GEMINI_THINKING_HEADROOM.fast),
    abortSignal: signal,
  };
  if (!thinking) config.thinkingConfig = { thinkingLevel: 'low' };
  let stream;
  try {
    stream = await ai.models.generateContentStream({ model, contents, config });
  } catch (error) {
    // A model or endpoint that predates thinkingLevel should still answer.
    if (!config.thinkingConfig || !/thinking/i.test((error && error.message) || '')) throw error;
    delete config.thinkingConfig;
    stream = await ai.models.generateContentStream({ model, contents, config });
  }
  let full = '';
  let finishReason = null;
  for await (const chunk of stream) {
    const candidate = chunk && chunk.candidates && chunk.candidates[0];
    if (candidate && candidate.finishReason) finishReason = candidate.finishReason;
    const text = chunk && chunk.text;
    if (text) { full += text; onToken(text); }
  }
  if (typeof onFinish === 'function') onFinish({ reason: finishReason });
  return full;
}

function createLLM(settings, dependencies = {}) {
  const resolved = resolveProvider(settings);
  const maxTokens = settings.smart ? 1400 : 700;

  return {
    ...resolved,
    async stream(params) {
      if (!resolved.ready) throw new Error(resolved.configurationError);
      const hasImages = collectImageDataUrls(params.imageDataUrls, params.imageDataUrl).length > 0;
      if (hasImages && !resolved.supportsVision) {
        throw new Error(`${resolved.label} ${resolved.model} does not support image input. Choose a vision-capable provider or model for screen features.`);
      }

      // params.maxTokens lets a mode ask for more room than the tier default.
      const args = { ...resolved, maxTokens, thinking: !!settings.smart, ...params };
      if (resolved.provider === 'openai') {
        const OpenAI = dependencies.OpenAI || require('openai');
        return streamOpenAICompatible({ ...args, OpenAI, clientOptions: { apiKey: resolved.apiKey } });
      }
      if (resolved.provider === 'azure') {
        const OpenAI = dependencies.OpenAI || require('openai');
        return streamOpenAICompatible({
          ...args,
          OpenAI,
          clientOptions: {
            apiKey: resolved.apiKey,
            baseURL: resolved.baseURL,
            defaultHeaders: { 'api-key': resolved.apiKey, Authorization: null },
          },
        });
      }
      // Any provider with a fixed baseURL is OpenAI-compatible (DeepSeek, Groq, OpenRouter, local Ollama, ...).
      // Azure is handled separately because it authenticates with an api-key header.
      if (resolved.baseURL) {
        const OpenAI = dependencies.OpenAI || require('openai');
        const extraBody = resolved.provider === 'nvidia'
          ? { chat_template_kwargs: { enable_thinking: false, force_nonempty_content: true } }
          : null;
        return streamOpenAICompatible({
          ...args,
          OpenAI,
          // Keyless local endpoints (Ollama) still require a placeholder so the SDK builds a client.
          clientOptions: { apiKey: resolved.apiKey || 'ollama', baseURL: resolved.baseURL },
          extraBody,
        });
      }
      if (resolved.provider === 'anthropic') {
        const Anthropic = dependencies.Anthropic || require('@anthropic-ai/sdk');
        return streamAnthropic({ ...args, Anthropic });
      }
      if (resolved.provider === 'gemini') {
        const { GoogleGenAI } = dependencies.GoogleGenAI
          ? { GoogleGenAI: dependencies.GoogleGenAI }
          : require('@google/genai');
        return streamGemini({ ...args, GoogleGenAI });
      }
      throw new Error(`Unknown provider: ${resolved.provider}`);
    },
  };
}

module.exports = { createLLM };
