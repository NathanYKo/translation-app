import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:8080';

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

// ── HTTP server ─────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || '/').split('?')[0];

  // POST /offer — proxy SDP offer to the WebRTC gateway
  if (req.method === 'POST' && urlPath === '/offer') {
    try {
      const body = await readBody(req);
      const gwResp = await fetch(`${GATEWAY_URL}/offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body,
      });
      if (!gwResp.ok) {
        sendJSON(res, 502, { error: 'Gateway error: ' + gwResp.status });
        return;
      }
      const sdp = await gwResp.text();
      res.writeHead(200, { 'Content-Type': 'application/sdp' });
      res.end(sdp);
    } catch (e) {
      sendJSON(res, 502, { error: e.message });
    }
    return;
  }

  // GET /api/config — gateway URL for the browser
  if (req.method === 'GET' && urlPath === '/api/config') {
    sendJSON(res, 200, { gateway: GATEWAY_URL });
    return;
  }

  // GET /api/metrics
  if (req.method === 'GET' && urlPath === '/api/metrics') {
    metrics.flush();
    sendJSON(res, 200, metrics.snapshot());
    return;
  }

  // POST /api/metrics/event
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

  // Static files
  const rel = urlPath === '/' ? '/index.html' : urlPath === '/admin/monitor' ? '/admin/monitor.html' : urlPath;
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
  console.log(`  Gateway proxy → ${GATEWAY_URL}/offer`);
  console.log('  Start the gateway:  cd gateway && python gateway.py');
  console.log('  Start the model:    cd model && python server.py --mock (or --model Qwen/Qwen2.5-Omni-7B)');
});

// Graceful shutdown
process.on('SIGINT', () => { console.log('\nShutting down...'); metrics.shutdown(); process.exit(0); });
process.on('SIGTERM', () => { metrics.shutdown(); process.exit(0); });