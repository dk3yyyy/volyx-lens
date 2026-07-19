// LLM factory — OpenAI / Anthropic / Gemini / Azure Foundry / DeepSeek.
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
  onToken,
  signal,
}) {
  const client = new OpenAI(clientOptions);
  const images = collectImageDataUrls(imageDataUrls, imageDataUrl);
  const messages = buildOpenAIMessages(system, turns, images);
  const baseRequest = { model, messages, stream: true };
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
  for await (const part of stream) {
    const delta = part.choices && part.choices[0] && part.choices[0].delta && part.choices[0].delta.content;
    if (delta) { full += delta; onToken(delta); }
  }
  return full;
}

async function streamAnthropic({ Anthropic, apiKey, model, system, turns, imageDataUrl, imageDataUrls, maxTokens, onToken, signal }) {
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
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta && event.delta.type === 'text_delta') {
      full += event.delta.text;
      onToken(event.delta.text);
    }
  }
  return full;
}

async function streamGemini({ GoogleGenAI, apiKey, model, system, turns, imageDataUrl, imageDataUrls, maxTokens, onToken, signal }) {
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
  const stream = await ai.models.generateContentStream({
    model,
    contents,
    config: { systemInstruction: system, maxOutputTokens: maxTokens, abortSignal: signal },
  });
  let full = '';
  for await (const chunk of stream) {
    const text = chunk && chunk.text;
    if (text) { full += text; onToken(text); }
  }
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
        throw new Error(`${resolved.label} does not support image input. Choose a vision-capable provider for screen features.`);
      }

      const args = { ...resolved, maxTokens, ...params };
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
      if (resolved.provider === 'deepseek') {
        const OpenAI = dependencies.OpenAI || require('openai');
        return streamOpenAICompatible({
          ...args,
          OpenAI,
          clientOptions: { apiKey: resolved.apiKey, baseURL: resolved.baseURL },
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
