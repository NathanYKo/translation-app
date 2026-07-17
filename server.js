import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleUpgrade, connect as wsConnect, OPCODES } from './ws.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Optional local .env (keeps keys out of the shell / command line).
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

// Translation (LLM) — OpenRouter.
const OR_API_KEY = process.env.OPENROUTER_API_KEY;
const OR_MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash';
const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Text-to-speech — ElevenLabs.
const EL_API_KEY = process.env.ELEVENLABS_API_KEY;
const EL_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
const EL_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';
const EL_URL = `https://api.elevenlabs.io/v1/text-to-speech/${EL_VOICE_ID}?output_format=mp3_44100_128`;
const EL_STREAM_URL = `https://api.elevenlabs.io/v1/text-to-speech/${EL_VOICE_ID}/stream?output_format=mp3_44100_128`;

// Speech-to-text — Deepgram.
const DG_API_KEY = process.env.DEEPGRAM_API_KEY;

// Shortened translation prompt (~40% fewer tokens).
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

// ── OpenRouter translate ────────────────────────────────────────────────────

async function translate(text) {
  const resp = await fetch(OR_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OR_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.OPENROUTER_REFERER || 'http://localhost',
      'X-OpenRouter-Title': 'Realtime Translator',
    },
    body: JSON.stringify({
      model: OR_MODEL,
      temperature: 0.3,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`OpenRouter ${resp.status}: ${errText.slice(0, 200)}`);
  }
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content ?? '';
  const parsed = extractJSON(content);
  if (parsed && typeof parsed.translation === 'string') {
    return { source: parsed.source === 'zh' ? 'zh' : 'en', translation: parsed.translation.trim() };
  }
  const translation = content.trim();
  const target = isCJK(translation) ? 'zh' : 'en';
  return { source: target === 'zh' ? 'en' : 'zh', translation };
}

// ── ElevenLabs TTS (batch) ──────────────────────────────────────────────────

async function textToSpeech(text) {
  const resp = await fetch(EL_URL, {
    method: 'POST',
    headers: { 'xi-api-key': EL_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: EL_MODEL, voice_settings: { stability: 0.4, similarity_boost: 0.7 } }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`ElevenLabs ${resp.status}: ${errText.slice(0, 200)}`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

// ── Deepgram STT (batch — fallback) ─────────────────────────────────────────

async function speechToText(audioBuffer, lang) {
  const langMap = { en: 'en', zh: 'zh-CN' };
  const params = new URLSearchParams({ model: 'nova-2', language: langMap[lang] || 'en', smart_format: 'true', punctuate: 'true' });
  const resp = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: 'POST',
    headers: { Authorization: `Token ${DG_API_KEY}`, 'Content-Type': 'audio/webm' },
    body: audioBuffer,
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Deepgram ${resp.status}: ${errText.slice(0, 200)}`);
  }
  const data = await resp.json();
  return (data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '').trim();
}

// ── Deepgram streaming STT proxy (WebSocket) ────────────────────────────────

async function handleStreamingSTT(wsConn, lang) {
  let dgConn = null;
  let finalTranscript = '';

  try {
    const langMap = { en: 'en', zh: 'zh-CN' };
    const params = new URLSearchParams({ model: 'nova-2', language: langMap[lang] || 'en', smart_format: 'true', punctuate: 'true' });
    dgConn = await wsConnect(`wss://api.deepgram.com/v1/listen?${params}`, { Authorization: `Token ${DG_API_KEY}` });

    // Browser audio → Deepgram
    wsConn.on('message', (data, isBinary) => {
      if (dgConn._closed) return;
      if (isBinary) {
        dgConn.send(data, OPCODES.BINARY);
      } else {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'stop') dgConn.send(JSON.stringify({ type: 'CloseStream' }));
        } catch {}
      }
    });

    // Deepgram transcripts → Browser
    dgConn.on('message', (data, isBinary) => {
      if (isBinary || wsConn._closed) return;
      try {
        const result = JSON.parse(data);
        const transcript = result?.channel?.alternatives?.[0]?.transcript || '';
        const isFinal = result?.is_final || false;
        const speechFinal = result?.speech_final || false;

        if (transcript) {
          wsConn.send(JSON.stringify({ type: 'transcript', text: transcript, isFinal }));
          if (isFinal) finalTranscript = transcript;
        }
        if (speechFinal && finalTranscript) {
          wsConn.send(JSON.stringify({ type: 'final', text: finalTranscript }));
          dgConn.close();
          wsConn.close();
        }
      } catch {}
    });

    wsConn.on('close', () => { if (dgConn && !dgConn._closed) dgConn.close(); });
    dgConn.on('close', () => {
      if (!wsConn._closed) {
        if (finalTranscript) wsConn.send(JSON.stringify({ type: 'final', text: finalTranscript }));
        wsConn.close();
      }
    });
    dgConn.on('error', (err) => {
      console.error('Deepgram WS error:', err.message);
      if (!wsConn._closed) { wsConn.send(JSON.stringify({ type: 'error', error: err.message })); wsConn.close(); }
    });
  } catch (err) {
    console.error('Deepgram connect error:', err.message);
    if (!wsConn._closed) { wsConn.send(JSON.stringify({ type: 'error', error: 'STT service unavailable' })); wsConn.close(); }
  }
}

// ── HTTP server ─────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || '/').split('?')[0];

  // POST /translate
  if (req.method === 'POST' && urlPath === '/translate') {
    if (!OR_API_KEY) { sendJSON(res, 500, { error: 'OPENROUTER_API_KEY is not set on the server' }); return; }
    try {
      const raw = await readBody(req);
      const { text } = JSON.parse(raw.toString() || '{}');
      if (!text || !text.trim()) { sendJSON(res, 200, { source: 'en', translation: '' }); return; }
      sendJSON(res, 200, await translate(text));
    } catch (e) { sendJSON(res, 502, { error: e.message || 'translation failed' }); }
    return;
  }

  // POST /stt  (batch fallback)
  if (req.method === 'POST' && urlPath === '/stt') {
    if (!DG_API_KEY) { sendJSON(res, 500, { error: 'DEEPGRAM_API_KEY is not set on the server' }); return; }
    try {
      const audioBuffer = await readBody(req);
      const lang = new URL(req.url, 'http://localhost').searchParams.get('lang') || 'en';
      if (!audioBuffer.length) { sendJSON(res, 200, { transcript: '' }); return; }
      sendJSON(res, 200, { transcript: await speechToText(audioBuffer, lang) });
    } catch (e) { sendJSON(res, 502, { error: e.message || 'stt failed' }); }
    return;
  }

  // POST /tts  (batch)
  if (req.method === 'POST' && urlPath === '/tts') {
    if (!EL_API_KEY) { sendJSON(res, 500, { error: 'ELEVENLABS_API_KEY is not set on the server' }); return; }
    try {
      const raw = await readBody(req);
      const { text } = JSON.parse(raw.toString() || '{}');
      if (!text || !text.trim()) { res.writeHead(204); res.end(); return; }
      const audio = await textToSpeech(text);
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audio.length, 'Cache-Control': 'no-store' });
      res.end(audio);
    } catch (e) { sendJSON(res, 502, { error: e.message || 'tts failed' }); }
    return;
  }

  // POST /tts-stream  (streaming — proxies chunked response from ElevenLabs)
  if (req.method === 'POST' && urlPath === '/tts-stream') {
    if (!EL_API_KEY) { sendJSON(res, 500, { error: 'ELEVENLABS_API_KEY is not set on the server' }); return; }
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
    } catch (e) { sendJSON(res, 502, { error: e.message || 'tts-stream failed' }); }
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

// ── WebSocket upgrade (/ws) for streaming STT ───────────────────────────────

server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/ws') {
    handleUpgrade(req, socket, head)
      .then((conn) => handleStreamingSTT(conn, u.searchParams.get('lang') || 'en'))
      .catch((err) => { console.error('WS upgrade error:', err.message); socket.destroy(); });
  } else {
    socket.destroy();
  }
});

// ── Start ───────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`Realtime translator (Deepgram + OpenRouter + ElevenLabs) listening on http://localhost:${PORT}`);
  if (!DG_API_KEY) console.warn('WARNING: DEEPGRAM_API_KEY is not set. Speech recognition will fail.');
  else console.log('  Deepgram STT: nova-2 (streaming + batch fallback)');
  if (!OR_API_KEY) console.warn('WARNING: OPENROUTER_API_KEY is not set. Translation will fail.');
  else console.log(`  OPENROUTER_MODEL: ${OR_MODEL}`);
  if (!EL_API_KEY) console.warn('WARNING: ELEVENLABS_API_KEY is not set. Speech output will fail.');
  else console.log(`  ELEVENLABS_VOICE_ID: ${EL_VOICE_ID}  MODEL: ${EL_MODEL}`);

  // Warm up TCP/TLS connections to all three APIs (non-blocking).
  warmUpConnections();
});

async function warmUpConnections() {
  const jobs = [];
  if (DG_API_KEY) jobs.push(fetch('https://api.deepgram.com/v1/projects', { headers: { Authorization: `Token ${DG_API_KEY}` } }).catch(() => {}));
  if (OR_API_KEY) jobs.push(fetch('https://openrouter.ai/api/v1/models', { headers: { Authorization: `Bearer ${OR_API_KEY}` } }).catch(() => {}));
  if (EL_API_KEY) jobs.push(fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': EL_API_KEY } }).catch(() => {}));
  await Promise.all(jobs);
  console.log('  API connections warmed up');
}
