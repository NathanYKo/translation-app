# agents.md — Realtime EN↔ZH Voice Translator

Reference for any agent working in this repo. Keep it accurate if the architecture changes.

## What this app is
A **no-button, realtime English ↔ Chinese voice translator** that runs in the browser.
You speak; it shows your text, translates it, and speaks the translation back in the
other language. The only UI controls are a single tap-to-start overlay (browser-mandated)
and a language indicator that flips each turn.

## Architecture (current: OpenRouter + ElevenLabs pipeline)
```
mic → Browser SpeechRecognition (STT, VAD)
        → POST /translate  → OpenRouter LLM (translate)   [server-side key]
        → POST /tts        → ElevenLabs TTS (speak)        [server-side key]
        → Browser <audio> playback
```
- **Both API keys live only on the server.** The browser never sees them and only
  exchanges JSON text + audio bytes with the server.
- STT (speech→text) and final playback (audio→speaker) happen in the browser.
- Translation (LLM) is OpenRouter; voice synthesis is ElevenLabs.

### History note
The app was originally specced for **Gemini Live** (`BidiGenerateContent` WebSocket,
speech-in/speech-out in one stream). After the user asked to use an OpenRouter key, it
was rebuilt as the STT→LLM→TTS pipeline below. The Gemini-Live version is no longer in
the tree. If a future task mentions "Gemini" or "realtime WebSocket", that is the
different, lower-latency approach and would need a Gemini API key.

## Stack
- **Backend:** Node.js (ESM, `"type": "module"`), **no dependencies**. Uses built-in
  `http`, `fs`, and global `fetch`. No framework, no bundler, no dotenv (a tiny inline
  `.env` reader is hand-rolled in `server.js`).
- **Frontend:** Vanilla JS + HTML + CSS in `public/`. No framework, no build step.
  Served statically by the backend.

## Files
| File | Role |
|---|---|
| `server.js` | HTTP static server + `/translate` and `/tts` proxies. Loads `.env`. |
| `public/index.html` | UI: `#start` tap overlay, `#lang` indicator, `#status`, `#transcript`. |
| `public/app.js` | STT capture, translation call, ElevenLabs playback, turn logic, loop guard. |
| `package.json` | `npm start` → `node server.js`. No deps. |
| `.env.example` | Template for required/optional env vars. Copy to `.env` and fill in. |

## Run
```bash
cp .env.example .env        # then put real keys in .env (never paste secrets in chat)
node server.js              # or: npm start
# open http://localhost:3000 in Chrome or Edge, tap to start, talk
```
- Requires **Chrome or Edge** (the Web Speech API `SpeechRecognition` is not in Firefox).
- A single tap is required by browsers to unlock mic + audio (autoplay/gesture rule).
- Works on `localhost` (secure context). For LAN/HTTPS you need a trusted cert.

## Environment variables
| Var | Required | Default | Notes |
|---|---|---|---|
| `OPENROUTER_API_KEY` | yes | — | Translation (LLM). |
| `ELEVENLABS_API_KEY` | yes | — | Voice synthesis (TTS). |
| `ELEVENLABS_VOICE_ID` | no | `21m00Tcm4TlvDq8ikWAM` ("Rachel") | Any voice id from the ElevenLabs account. |
| `ELEVENLABS_MODEL` | no | `eleven_multilingual_v2` | Handles both English and Chinese. |
| `OPENROUTER_MODEL` | no | `google/gemini-2.5-flash-preview` | Any OpenRouter chat model slug. |
| `PORT` | no | `3000` | Listen port. |

Keys may also be passed as real shell env vars; `.env` is merged only for vars not
already present in `process.env`.

## API contracts (server)
### `POST /translate`
- Request: `{ "text": "<recognized speech>" }`
- Response: `{ "source": "en"|"zh", "translation": "<translated text>" }`
- The server sends a system prompt instructing the model to return **only** a JSON
  object `{"source","translation"}`. `extractJSON()` tolerates ```json fences. On
  failure it falls back to treating the raw text as the translation and guessing the
  target language by CJK presence. Empty input → `200 {source:"en",translation:""}`.
- Missing key → `500`. Upstream error → `502`.

### `POST /tts`
- Request: `{ "text": "<text to speak>" }`
- Response: `audio/mpeg` (MP3, 44.1kHz/128k) bytes. Empty input → `204`.
- Missing key → `500`. Upstream error → `502`.
- The browser plays the returned MP3 via a `Blob` + `URL.createObjectURL` + `<audio>`.

## Frontend behavior (`public/app.js`)
- **`begin()`** (on tap): hides overlay, creates `SpeechRecognition`
  (`continuous=true`, `interimResults=false`), starts listening.
- **Language indicator:** `expectLang` (`en`|`zh`, init from `?lang=zh` else `en`).
  `updateLangUI()` sets `#lang` text and `recognition.lang` (`en-US`/`zh-CN`) so STT
  always matches what the UI tells the user to speak. Flips each turn (EN↔ZH ping-pong).
- **`onResult`** (final transcript): stops recognition (loop guard), calls
  `handleUtterance`.
- **`handleUtterance`**: appends "You" bubble → `POST /translate` → appends
  "Translation" bubble → `speak()`.
- **`speak`**: `POST /tts` → play MP3. On end/error, flips `expectLang`, updates UI,
  resumes listening.
- **Loop guard:** `speaking` flag; recognition is stopped while the translator speaks
  so it cannot hear its own voice. `stopCurrentAudio()` pauses playback for barge-in.
- **Transcript:** `#transcript` shows alternating "You (English/Chinese)" and
  "Translation (English/Chinese)" bubbles, auto-scrolled.

## Verification
```bash
node --check server.js && node --check public/app.js
# start with dummy keys to confirm wiring (expect 502s from providers):
OPENROUTER_API_KEY=dummy OR_API_KEY ELEVENLABS_API_KEY=dummy node server.js
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/            # 200
curl -s -X POST localhost:3000/translate -H 'Content-Type: application/json' -d '{"text":""}'   # 200 {source:en,translation:""}
curl -s -X POST localhost:3000/tts -H 'Content-Type: application/json' -d '{"text":"hi"}'         # 502 from ElevenLabs (proves proxy reaches it)
```

## Failure modes an agent should check
- **Nothing translates:** `OPENROUTER_API_KEY` missing/wrong, or `OPENROUTER_MODEL`
  slug invalid for the account. Check server startup warnings.
- **Translation shows but no audio:** `ELEVENLABS_API_KEY` missing/wrong, or
  `ELEVENLABS_VOICE_ID` not in the account. `/tts` will return 502.
- **No speech captured:** not using Chrome/Edge, mic permission denied, or user spoke
  the language not indicated (STT `lang` is locked to the indicator).
- **Audio won't play:** browser autoplay policy — must follow the tap-to-start gesture.
- **Loops / repeats itself:** loop guard (`speaking` flag + `recognition.stop()`) must
  stay in place; do not let recognition run while audio plays.

## Key constraints to preserve
- **No buttons** in normal operation (tap-to-start is the only gesture, browser-mandated).
- **Keys never reach the browser.**
- **One continuous translation stream per turn**, driven by the language indicator.
