import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect as wsConnect, OPCODES } from './ws.js';
import { MetricsCollector } from './metrics/dist/index.js';

const metrics = new MetricsCollector();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
try {
  const envText = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envText.split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) {
      let val = m[2].replace(/\s+#.*/, '').trim();
      process.env[m[1]] = val.replace(/^["']|["']$/g, '');
    }
  }
} catch { /* no .env file */ }

const PORT = Number(process.env.PORT) || 3000;

const OR_API_KEY = process.env.OPENROUTER_API_KEY;
const OR_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash';
const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';

const EL_API_KEY = process.env.ELEVENLABS_API_KEY;
const EL_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
const EL_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';
const EL_URL = `https://api.elevenlabs.io/v1/text-to-speech/${EL_VOICE_ID}?output_format=mp3_44100_128`;
const EL_STREAM_URL = `https://api.elevenlabs.io/v1/text-to-speech/${EL_VOICE_ID}/stream?output_format=mp3_44100_128`;

const DG_API_KEY = process.env.DEEPGRAM_API_KEY;

const SYSTEM_PROMPT = `Translate between English and Chinese (Mandarin). Detect input language: English→Chinese, Chinese→English. Reply with ONLY JSON: {"source":"en"|"zh","translation":"<text>"}. Keep it natural and concise. Empty/nonsense → {"source":"en","translation":""}.`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const PUBLIC_DIR = path.join(__dirname, 'public');

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => {
      chunks.push(c);
      if (chunks.reduce((n, c) => n + c.length, 0) > 5e6) req.destroy();
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function extractJSON(text) {
  let t = (text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch { return null; }
}

function isCJK(s) { return /[一-鿿]/.test(s); }

/** Rough estimate of audio duration in seconds from byte size (Opus ~16 kbps) */
function estimateAudioDuration(bytes) {
  if (!bytes || bytes <= 0) return 0;
  // Opus at ~16kbps: bytes / (16000/8) = bytes / 2000 ≈ seconds
  return bytes / 2000;
}

// ── OpenRouter translate ────────────────────────────────────────────────────

async function translate(text) {
  const start = Date.now();
  let success = false;
  let inputChars = text.length;
  let outputChars = 0;
  let errorType = null;
  const resp = await fetch(OR_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OR_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.OPENROUTER_REFERER || 'http://localhost',
      'X-OpenRouter-Title': 'Realtime Translator',
    },
    body: JSON.stringify({
      model: OR_MODEL, temperature: 0.3,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    const error = new Error(`OpenRouter ${resp.status}: ${errText.slice(0, 200)}`);
    errorType = 'server_error';
    const latency = Date.now() - start;
    metrics.recordApiCall({ provider: 'openrouter', operation: 'translate', success: false, latencyMs: latency, inputChars, outputChars: 0, audioSeconds: 0, audioBytes: 0, errorType, errorDetail: `${resp.status}` });
    throw error;
  }
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content ?? '';
  outputChars = content.length;
  const parsed = extractJSON(content);
  success = true;
  const latency = Date.now() - start;
  metrics.recordApiCall({ provider: 'openrouter', operation: 'translate', success: true, latencyMs: latency, inputChars, outputChars, audioSeconds: 0, audioBytes: 0, errorType: null, errorDetail: null });
  if (parsed && typeof parsed.translation === 'string') {
    return { source: parsed.source === 'zh' ? 'zh' : 'en', translation: parsed.translation.trim() };
  }
  const translation = content.trim();
  const target = isCJK(translation) ? 'zh' : 'en';
  return { source: target === 'zh' ? 'en' : 'zh', translation };
}

// ── ElevenLabs TTS ──────────────────────────────────────────────────────────

async function textToSpeech(text) {
  const start = Date.now();
  let success = false;
  let errorType = null;
  let audioBytes = 0;
  const resp = await fetch(EL_URL, {
    method: 'POST',
    headers: { 'xi-api-key': EL_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: EL_MODEL, voice_settings: { stability: 0.4, similarity_boost: 0.7 } }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    errorType = 'server_error';
    const latency = Date.now() - start;
    metrics.recordApiCall({ provider: 'elevenlabs', operation: 'tts', success: false, latencyMs: latency, inputChars: text.length, outputChars: 0, audioSeconds: 0, audioBytes: 0, errorType, errorDetail: `${resp.status}` });
    throw new Error(`ElevenLabs ${resp.status}: ${errText.slice(0, 200)}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  audioBytes = buf.length;
  success = true;
  const latency = Date.now() - start;
  metrics.recordApiCall({ provider: 'elevenlabs', operation: 'tts', success: true, latencyMs: latency, inputChars: text.length, outputChars: text.length, audioSeconds: 0, audioBytes, errorType: null, errorDetail: null });
  return buf;
}

// ── Deepgram STT (batch fallback) ───────────────────────────────────────────

async function speechToText(audioBuffer, lang) {
  const start = Date.now();
  let success = false;
  let errorType = null;
  const audioBytes = audioBuffer.length;
  const audioSeconds = estimateAudioDuration(audioBytes);
  const langMap = { en: 'en', zh: 'zh-CN' };
  const params = new URLSearchParams({ model: 'nova-2', language: langMap[lang] || 'en', smart_format: 'true', punctuate: 'true' });
  const resp = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: 'POST',
    headers: { Authorization: `Token ${DG_API_KEY}`, 'Content-Type': 'audio/webm' },
    body: audioBuffer,
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    errorType = 'server_error';
    const latency = Date.now() - start;
    metrics.recordApiCall({ provider: 'deepgram', operation: 'stt', success: false, latencyMs: latency, inputChars: 0, outputChars: 0, audioSeconds, audioBytes, errorType, errorDetail: `${resp.status}` });
    throw new Error(`Deepgram ${resp.status}: ${errText.slice(0, 200)}`);
  }
  const data = await resp.json();
  const transcript = (data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '').trim();
  success = true;
  const latency = Date.now() - start;
  metrics.recordApiCall({ provider: 'deepgram', operation: 'stt', success: true, latencyMs: latency, inputChars: 0, outputChars: transcript.length, audioSeconds, audioBytes, errorType: null, errorDetail: null });
  return transcript;
}

// ── Streaming STT via SSE + fetch (browser-friendly, no WebSocket needed) ──

const sttSessions = new Map();  // sessionId → { dgConn, res, startTime, lang }

async function startSttSession(req, res, lang) {
  const sttStartTime = Date.now();
  const sessionId = crypto.randomUUID();
  const langMap = { en: 'en', zh: 'zh-CN' };
  const params = new URLSearchParams({ 
    model: 'nova-2', 
    language: langMap[lang] || 'en', 
    smart_format: 'true', 
    punctuate: 'true',
    // Deepgram endpointing — server-side silence detection
    endpointing: 'true',
    utterance_end_ms: '1500',
    interim_results: 'true',
  });
  const dgUrl = `wss://api.deepgram.com/v1/listen?${params}`;

  console.log(`[stt] session ${sessionId} opening Deepgram stream…`);
  const dgConn = await wsConnect(dgUrl, { Authorization: `Token ${DG_API_KEY}` });
  console.log(`[stt] session ${sessionId} Deepgram connected`);

  sttSessions.set(sessionId, { dgConn, res, startTime: sttStartTime, lang });

  // Send session ID to browser
  res.write(`data: ${JSON.stringify({ type: 'session', sessionId })}\n\n`);

  // Deepgram transcripts → SSE → Browser
  dgConn.on('message', (data, isBinary) => {
    if (isBinary || res.writableEnded) return;
    try {
      const result = JSON.parse(data);
      const transcript = result?.channel?.alternatives?.[0]?.transcript || '';
      const isFinal = result?.is_final || false;
      const speechFinal = result?.speech_final || false;

      if (transcript) {
        res.write(`data: ${JSON.stringify({ type: 'transcript', text: transcript, isFinal })}\n\n`);
      }
      if (speechFinal) {
        res.write(`data: ${JSON.stringify({ type: 'final', text: transcript })}\n\n`);
        // Record streaming STT metrics
        const sttLatency = Date.now() - sttStartTime;
        const audioSeconds = estimateAudioDuration(0); // rough: use latency as proxy
        metrics.recordApiCall({ provider: 'deepgram', operation: 'stt_streaming', success: true, latencyMs: sttLatency, inputChars: 0, outputChars: transcript.length, audioSeconds, audioBytes: 0, errorType: null, errorDetail: null });
        cleanup();
      }
    } catch {}
  });

  dgConn.on('close', () => cleanup());
  dgConn.on('error', (err) => {
    console.error(`[stt] session ${sessionId} Deepgram error:`, err.message);
    const sttLatency = Date.now() - sttStartTime;
    metrics.recordApiCall({ provider: 'deepgram', operation: 'stt_streaming', success: false, latencyMs: sttLatency, inputChars: 0, outputChars: 0, audioSeconds: 0, audioBytes: 0, errorType: 'server_error', errorDetail: err.message });
    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
    cleanup();
  });

  // Clean up when browser disconnects (closes SSE)
  req.on('close', () => {
    console.log(`[stt] session ${sessionId} browser disconnected`);
    cleanup();
  });

  function cleanup() {
    if (dgConn && !dgConn._closed) dgConn.close();
    sttSessions.delete(sessionId);
    if (!res.writableEnded) res.end();
  }

  return sessionId;
}

// ── HTTP server ─────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || '/').split('?')[0];

  // POST /translate
  if (req.method === 'POST' && urlPath === '/translate') {
    if (!OR_API_KEY) { sendJSON(res, 500, { error: 'OPENROUTER_API_KEY not set' }); return; }
    try {
      const raw = await readBody(req);
      const { text } = JSON.parse(raw.toString() || '{}');
      if (!text || !text.trim()) { sendJSON(res, 200, { source: 'en', translation: '' }); return; }
      // Track session from req
      const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
      // beginSession is idempotent-ish but we don't persist session id per request here
      sendJSON(res, 200, await translate(text));
    } catch (e) { sendJSON(res, 502, { error: e.message }); }
    return;
  }

  // GET /api/metrics
  if (req.method === 'GET' && urlPath === '/api/metrics') {
    metrics.flush();
    sendJSON(res, 200, metrics.snapshot());
    return;
  }

  // POST /api/metrics/event (browser timing events)
  if (req.method === 'POST' && urlPath === '/api/metrics/event') {
    try {
      const raw = await readBody(req);
      const event = JSON.parse(raw.toString() || '{}');
      if (event.marks && event.sessionId) {
        const ms = event.marks;
        const turn = {
          sessionId: event.sessionId,
          sourceLang: event.sourceLang || 'en',
          targetLang: event.targetLang || 'zh',
          turnNumber: 0,
          transcriptLen: event.transcriptLen || 0,
          translationLen: event.translationLen || 0,
          sttLatencyMs: ms.stt_received && ms.turn_start ? Math.round(ms.stt_received - ms.turn_start) : 0,
          translateLatencyMs: ms.translate_received && ms.translate_sent ? Math.round(ms.translate_received - ms.translate_sent) : 0,
          ttsLatencyMs: ms.tts_played && ms.tts_sent ? Math.round(ms.tts_played - ms.tts_sent) : 0,
          e2eLatencyMs: ms.turn_complete && ms.turn_start ? Math.round(ms.turn_complete - ms.turn_start) : 0,
          ttsMode: event.ttsMode || 'unknown',
          audioBytes: event.blobSize || 0,
          speechDurationMs: event.speechDurationMs || 0,
          fallback: event.fallback || false,
          sttOk: event.error !== 'stt_error' ? 1 : 0,
          translateOk: event.error !== 'translate_error' ? 1 : 0,
          ttsOk: event.error !== 'tts_error' ? 1 : 0,
          sttError: event.error === 'stt_error' ? 'browser_stt_failed' : null,
          translateError: event.error === 'translate_error' ? 'browser_translate_failed' : null,
          ttsError: event.error === 'tts_error' ? 'browser_tts_failed' : null,
          timestamp: Date.now(),
        };
        metrics.recordTurn(turn);
      }
      res.writeHead(204);
      res.end();
    } catch {
      res.writeHead(204);
      res.end();
    }
    return;
  }

  if (req.method === 'POST' && urlPath === '/stt') {
    if (!DG_API_KEY) { sendJSON(res, 500, { error: 'DEEPGRAM_API_KEY not set' }); return; }
    try {
      const audioBuffer = await readBody(req);
      const lang = new URL(req.url, 'http://localhost').searchParams.get('lang') || 'en';
      if (!audioBuffer.length) { sendJSON(res, 200, { transcript: '' }); return; }
      sendJSON(res, 200, { transcript: await speechToText(audioBuffer, lang) });
    } catch (e) { sendJSON(res, 502, { error: e.message }); }
    return;
  }

  // GET /stt-sse?lang=en  (streaming STT — SSE endpoint)
  if (req.method === 'GET' && urlPath === '/stt-sse') {
    if (!DG_API_KEY) { sendJSON(res, 500, { error: 'DEEPGRAM_API_KEY not set' }); return; }
    const lang = new URL(req.url, 'http://localhost').searchParams.get('lang') || 'en';
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    try {
      await startSttSession(req, res, lang);
    } catch (err) {
      console.error('[stt] session open failed:', err.message);
      try {
        res.write(`data: ${JSON.stringify({ type: 'error', error: 'STT unavailable: ' + err.message })}\n\n`);
        res.end();
      } catch {}
    }
    return;
  }

  // POST /stt-chunk  (audio chunk → Deepgram, identified by X-Session-Id)
  if (req.method === 'POST' && urlPath === '/stt-chunk') {
    try {
      const sessionId = req.headers['x-session-id'];
      const session = sttSessions.get(sessionId);
      if (!session) { sendJSON(res, 404, { error: 'Session not found' }); return; }
      const chunk = await readBody(req);
      if (chunk.length > 0 && !session.dgConn._closed) {
        session.dgConn.send(chunk, OPCODES.BINARY);
      }
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      console.error('[stt] chunk error:', e.message);
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // POST /stt-stop  (signal end of speech)
  if (req.method === 'POST' && urlPath === '/stt-stop') {
    try {
      const sessionId = req.headers['x-session-id'];
      const session = sttSessions.get(sessionId);
      if (!session) { sendJSON(res, 404, { error: 'Session not found' }); return; }
      if (!session.dgConn._closed) {
        session.dgConn.send(JSON.stringify({ type: 'CloseStream' }));
      }
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      console.error('[stt] stop error:', e.message);
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // POST /tts  (batch)
  if (req.method === 'POST' && urlPath === '/tts') {
    if (!EL_API_KEY) { sendJSON(res, 500, { error: 'ELEVENLABS_API_KEY not set' }); return; }
    try {
      const raw = await readBody(req);
      const { text } = JSON.parse(raw.toString() || '{}');
      if (!text || !text.trim()) { res.writeHead(204); res.end(); return; }
      const audio = await textToSpeech(text);
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audio.length, 'Cache-Control': 'no-store' });
      res.end(audio);
    } catch (e) { sendJSON(res, 502, { error: e.message }); }
    return;
  }

  // POST /tts-stream  (streaming TTS)
  if (req.method === 'POST' && urlPath === '/tts-stream') {
    if (!EL_API_KEY) { sendJSON(res, 500, { error: 'ELEVENLABS_API_KEY not set' }); return; }
    try {
      const raw = await readBody(req);
      const { text } = JSON.parse(raw.toString() || '{}');
      if (!text || !text.trim()) { res.writeHead(204); res.end(); return; }
      const resp = await fetch(EL_STREAM_URL, {
        method: 'POST',
        headers: { 'xi-api-key': EL_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: EL_MODEL, voice_settings: { stability: 0.4, similarity_boost: 0.7 } }),
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`ElevenLabs ${resp.status}: ${errText.slice(0, 200)}`);
      }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Transfer-Encoding': 'chunked', 'Cache-Control': 'no-store' });
      const reader = resp.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } catch (e) { sendJSON(res, 502, { error: e.message }); }
    return;
  }

  // Static files
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ── Start ───────────────────────────────────────────────────────────────────

process.on('uncaughtException', (e) => { console.error('[FATAL]', e.message, e.stack); });
process.on('unhandledRejection', (e) => { console.error('[UNHANDLED]', e); });

server.listen(PORT, () => {
  console.log(`Realtime translator listening on http://localhost:${PORT}`);
  if (!DG_API_KEY) console.warn('WARNING: DEEPGRAM_API_KEY not set.');
  else console.log('  Deepgram STT: nova-2 (SSE streaming + batch fallback)');
  if (!OR_API_KEY) console.warn('WARNING: OPENROUTER_API_KEY not set.');
  else console.log(`  Model: ${OR_MODEL}`);
  if (!EL_API_KEY) console.warn('WARNING: ELEVENLABS_API_KEY not set.');
  else console.log(`  ElevenLabs: ${EL_VOICE_ID} / ${EL_MODEL}`);
  warmUpConnections();
});

// Graceful shutdown
process.on('SIGINT', () => { console.log('\nShutting down...'); metrics.shutdown(); process.exit(0); });
process.on('SIGTERM', () => { metrics.shutdown(); process.exit(0); });

async function warmUpConnections() {
  const jobs = [];
  if (DG_API_KEY) jobs.push(fetch('https://api.deepgram.com/v1/projects', { headers: { Authorization: `Token ${DG_API_KEY}` } }).catch(() => {}));
  if (OR_API_KEY) jobs.push(fetch('https://openrouter.ai/api/v1/models', { headers: { Authorization: `Bearer ${OR_API_KEY}` } }).catch(() => {}));
  if (EL_API_KEY) jobs.push(fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': EL_API_KEY } }).catch(() => {}));
  await Promise.all(jobs);
  console.log('  API connections warmed up');
}
