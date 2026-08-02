# Realtime EN↔ZH Voice Translator

A **no-button, realtime English ↔ Chinese voice translator** that runs entirely in the browser. Speak, hear your transcription, and get a spoken translation in the other language — all with a single tap to start.

Built-in **metrics & analytics**: SQLite-backed, anonymized, with live dashboard.

## How it works

Your voice is captured in the browser (Chrome/Edge), transcribed to text via Deepgram (or browser STT), translated by an LLM via OpenRouter, then spoken back with ElevenLabs realistic TTS. No framework, no build step.

```
mic → Deepgram STT (streaming or batch)
        → OpenRouter LLM (translation)
        → ElevenLabs TTS (streaming or batch)
        → Browser audio playback
```

**All API keys live only on the server.** The browser never sees them.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+ (tested on 22)
- **Chrome or Edge** — the Web Speech API isn't available in Firefox
- An **OpenRouter API key** ([openrouter.ai/keys](https://openrouter.ai/keys))
- An **ElevenLabs API key** ([elevenlabs.io](https://elevenlabs.io))
- (Optional) A **Deepgram API key** for STT ([deepgram.com](https://deepgram.com))

## Setup

```bash
# 1. Clone or enter the project directory
cd translation-app

# 2. Install dependencies
npm install

# 3. Create your environment file
cp .env.example .env

# 4. Add your API keys to .env
#    (never commit this file or paste keys in chat)
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxx
ELEVENLABS_API_KEY=xxxxxxxxx
DEEPGRAM_API_KEY=xxxxxxxxx

# 5. Start the server
npm start
```

Then open **http://localhost:3000** in Chrome or Edge. Tap anywhere on the page to start, and speak into your mic.

## Environment variables

### Required
| Variable | Default | Notes |
|---|---|---|
| `OPENROUTER_API_KEY` | — | Translation (LLM) |
| `ELEVENLABS_API_KEY` | — | Voice synthesis (TTS) |

### Optional — service configuration
| Variable | Default | Notes |
|---|---|---|
| `DEEPGRAM_API_KEY` | — | STT via Nova-2 (batch + streaming via SSE). Without this, falls back to browser SpeechRecognition |
| `ELEVENLABS_VOICE_ID` | `21m00Tcm4TlvDq8ikWAM` (Rachel) | Any ElevenLabs voice ID |
| `ELEVENLABS_MODEL` | `eleven_multilingual_v2` | Handles both English and Chinese |
| `OPENROUTER_MODEL` | `google/gemini-2.5-flash` | Any OpenRouter chat model slug |
| `PORT` | `3000` | Listen port |
| `OPENROUTER_REFERER` | `http://localhost` | Referer header sent to OpenRouter |

### Optional — pricing overrides (defaults reflect public rates Aug 2026)
| Variable | Default | Notes |
|---|---|---|
| `OPENROUTER_PRICE_PER_1K_INPUT` | `0.00015` | USD per 1K input tokens |
| `OPENROUTER_PRICE_PER_1K_OUTPUT` | `0.00060` | USD per 1K output tokens |
| `ELEVENLABS_PRICE_PER_CHAR` | `0.00030` | USD per character |
| `DEEPGRAM_PRICE_PER_MINUTE` | `0.0059` | USD per audio minute |

## Usage tips

- **Language ping-pong:** Each turn flips the expected language (EN→ZH, ZH→EN). Speak the language shown on screen.
- **Tap the language pill** to manually switch the expected language.
- **Tap the center circle** to pause/resume listening.
- **Autoplay gesture:** Browsers require one tap or click before they'll play audio. The start overlay handles this.
- **Loop guard:** The mic stops while the translation is spoken so the app never hears its own voice.
- **Restart after any change:** The server doesn't auto-reload — stop it (`Ctrl+C`) and start it again.

---

## Metrics & Analytics

The app includes a built-in, anonymized analytics system with SQLite persistence.

### Architecture

```
Browser (app.js)           Server (server.js)          SQLite (data/metrics.db)
     │                          │                            │
     │── /api/metrics/event ──→ │── MetricsCollector ──────→ │ sessions
     │   (timing marks)         │   (batched writes, 5s)     │ turns
     │                          │                            │ api_calls
     │←── /api/metrics ────────│                            │ daily_aggregates
     │   (JSON snapshot)        │                            │
     │                          │── server.js instrumentation
     │                          │   (translate, TTS, STT)
```

### What's tracked

| Metric | Source | Privacy |
|---|---|---|
| Session count | Browser | Session ID is `SHA256(salt + IP + minute)` — no raw IP stored |
| Turn count | Browser | Anonymized |
| Language direction (EN→ZH / ZH→EN) | Browser | ✅ |
| STT latency | Browser `performance.now()` marks | ✅ |
| Translate latency | Browser marks | ✅ |
| TTS latency | Browser marks | ✅ |
| End-to-end turn latency | Browser marks | ✅ |
| Streaming vs batch vs browser TTS usage | Browser | ✅ |
| Fallback rate | Browser | ✅ |
| API call errors | Server (auto) | Error detail stripped to status code |
| Cost estimation | Server (public pricing) | Per-provider, configurable via env |
| Speech duration | Browser VAD | ✅ |

**Not stored:** transcripts, translations, IP addresses, user agent strings (only browser family), or any PII.

### Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/metrics` | GET | JSON snapshot of today's stats, latencies, costs, errors |
| `/api/metrics/event` | POST | Browser sends per-turn timing marks (fire-and-forget) |

### Dashboard

Open **http://localhost:3000/admin/monitor** for a live dashboard that auto-refreshes every 5 seconds:

- Live counters (sessions, turns, error rate)
- Latency bars (STT, Translate, TTS, End-to-End)
- Quality panel (streaming TTS %, fallback %, estimated cost)
- Language direction bar
- Error type table
- Uptime and DB health status

---

## API endpoints

### `POST /translate`
- Request: `{ "text": "<recognized speech>" }`
- Response: `{ "source": "en"|"zh", "translation": "<translated text>" }`

### `POST /tts`
- Request: `{ "text": "<text to speak>" }`
- Response: `audio/mpeg` bytes

### `POST /tts-stream`
- Same as `/tts` but streams the MP3 response (chunked transfer encoding)

### `POST /stt`
- Request: binary `audio/webm` with `?lang=en|zh` query param
- Response: `{ "transcript": "<recognized text>" }`

### `GET /stt-sse?lang=en`
- Server-Sent Events endpoint for streaming STT via Deepgram WebSocket
- Sends `data:` lines with `session`, `transcript`, `final`, and `error` event types
- Browser sends audio chunks to `POST /stt-chunk` with `X-Session-Id` header

### `POST /stt-chunk`
- Sends an audio chunk to an active streaming STT session
- Header: `X-Session-Id` (from `/stt-sse` session event)

### `POST /stt-stop`
- Signals end of audio for the active streaming session
- Header: `X-Session-Id`

## Files

### Application
| File | Purpose |
|---|---|
| `server.js` | HTTP server with all proxy endpoints, static file serving, metrics integration |
| `public/index.html` | Single-page UI with tap-to-start, language indicator, transcript |
| `public/app.js` | Speech recognition, translation calls, TTS playback, metrics instrumentation |
| `public/admin/monitor.html` | Live metrics dashboard |
| `ws.js` | Zero-dependency WebSocket client/server (used for Deepgram streaming) |

### Metrics module (TypeScript → compiled JS)
| File | Purpose |
|---|---|
| `metrics/types.ts` | All TypeScript interfaces |
| `metrics/db.ts` | SQLite schema, migrations, prepared statements, aggregate queries |
| `metrics/anonymize.ts` | Session hashing, UA sanitization, error stripping |
| `metrics/cost.ts` | Pricing constants and cost estimators |
| `metrics/index.ts` | `MetricsCollector` class with batched writes |
| `metrics/tsconfig.json` | TypeScript configuration |
| `metrics/dist/` | Compiled output (auto-generated by `npm run build:metrics`) |

### Data
| File | Purpose |
|---|---|
| `data/metrics.db` | SQLite database (auto-created on first run, gitignored) |
| `data/metrics.salt` | Persistent salt for anonymized session hashes (gitignored) |

## Verification

```bash
node --check server.js && node --check public/app.js

# Start with dummy keys to verify wiring (expect 502s from providers):
OPENROUTER_API_KEY=test ELEVENLABS_API_KEY=test DEEPGRAM_API_KEY=test node server.js

# Verify endpoints
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/            # 200
curl -s http://localhost:3000/api/metrics          # JSON snapshot
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/admin/monitor  # 200

# Verify translate proxy (expects 401/502 without real key)
curl -s -X POST localhost:3000/translate -H 'Content-Type: application/json' -d '{"text":"hello"}'
```

## License

MIT