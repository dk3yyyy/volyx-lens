#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { resolveRealtimeTranscription, normalizeTranscriptionLanguage } = require('../src/provider-config');
const { buildRealtimeConnection } = require('../src/realtime-stt');
const { AUDIO_SAMPLE_RATE } = require('../src/audio-config');

const HELP = `Usage: npm run test:azure-realtime

Reads Volyx Lens's existing local settings, opens one short Azure Realtime connection,
configures a transcription session, prints a sanitized result, and closes.
The API key is never printed or placed in the URL.

Optional environment variable:
  VOLYX_LENS_SETTINGS_FILE=/absolute/path/to/volyx-lens-data.json
`;

function settingsPath() {
  const override = process.env.VOLYX_LENS_SETTINGS_FILE;
  if (override) return path.resolve(override);
  if (process.platform === 'darwin') {
    const current = path.join(os.homedir(), 'Library', 'Application Support', 'Volyx Lens', 'volyx-lens-data.json');
    const legacy = path.join(os.homedir(), 'Library', 'Application Support', 'volyx-lens-legacy', 'settings.json');
    return fs.existsSync(current) ? current : legacy;
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const current = path.join(configHome, 'Volyx Lens', 'volyx-lens-data.json');
  const legacy = path.join(configHome, 'volyx-lens-legacy', 'settings.json');
  return fs.existsSync(current) ? current : legacy;
}

function redact(value, secret) {
  let text = String(value || 'Unknown Azure error');
  if (secret) text = text.split(secret).join('[REDACTED]');
  return text.replace(/([?&]api-key=)[^&\s]+/gi, '$1[REDACTED]');
}

async function probe() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(HELP);
    return;
  }

  const file = settingsPath();
  if (!fs.existsSync(file)) {
    throw new Error(`Volyx Lens settings were not found at ${file}. Open Volyx Lens, save Settings, and try again.`);
  }

  let settings;
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error(`Volyx Lens settings at ${file} are not valid JSON.`); }

  const resolved = resolveRealtimeTranscription(settings);
  if (resolved.provider !== 'azure') {
    throw new Error('Realtime provider is not Azure Foundry. Select it in Volyx Lens Settings, click Done, and retry.');
  }
  if (!resolved.ready) throw new Error(resolved.configurationError);

  const { url, headers } = buildRealtimeConnection(resolved);
  const language = normalizeTranscriptionLanguage(settings.transcription?.language);
  const host = new URL(url).host;
  console.log(`Testing Azure Realtime host: ${host}`);
  console.log(`Deployment: ${resolved.model}`);
  console.log('Opening one short transcription session...');

  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.terminate(); } catch {}
      error ? reject(error) : resolve();
    };

    const socket = new WebSocket(url, { headers });
    const timer = setTimeout(() => finish(new Error('Timed out waiting for Azure Realtime after 15 seconds.')), 15000);

    socket.on('open', () => {
      socket.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: AUDIO_SAMPLE_RATE },
              transcription: {
                model: resolved.model,
                ...(language ? { language } : {}),
                ...(settings.transcription?.delay ? { delay: settings.transcription.delay } : {}),
              },
              turn_detection: null,
            },
          },
        },
      }));
    });

    socket.on('message', (raw) => {
      let event;
      try { event = JSON.parse(raw.toString()); } catch { return; }
      if (event.type === 'session.updated') {
        console.log('SUCCESS: Azure accepted the endpoint, API key, deployment, and transcription session configuration.');
        finish();
      } else if (event.type === 'error' || event.type === 'conversation.item.input_audio_transcription.failed') {
        const detail = event.error?.message || event.error?.code || event.message || event.type;
        finish(new Error(`Azure event error: ${redact(detail, resolved.apiKey)}`));
      }
    });

    socket.on('unexpected-response', (_request, response) => {
      const chunks = [];
      response.on('data', (chunk) => {
        if (Buffer.concat(chunks).length < 4096) chunks.push(Buffer.from(chunk));
      });
      response.on('end', () => {
        const body = redact(Buffer.concat(chunks).toString('utf8').slice(0, 4096), resolved.apiKey);
        finish(new Error(`Azure WebSocket handshake failed with HTTP ${response.statusCode}${body ? `: ${body}` : ''}`));
      });
    });

    socket.on('error', (error) => finish(new Error(`WebSocket error: ${redact(error.message, resolved.apiKey)}`)));
    socket.on('close', (code, reason) => {
      if (!settled) finish(new Error(`Azure closed the connection before configuration completed (${code}: ${redact(reason, resolved.apiKey)})`));
    });
  });
}

probe().catch((error) => {
  console.error(`FAILED: ${error.message}`);
  process.exitCode = 1;
});
