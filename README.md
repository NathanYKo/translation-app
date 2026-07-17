# Realtime EN↔ZH Voice Translator

A **no-button, realtime English ↔ Chinese voice translator** that runs entirely in the browser. Speak, hear your transcription, and get a spoken translation in the other language — all with a single tap to start.

## How it works

Your voice is captured in the browser (Chrome/Edge), transcribed to text, translated by an LLM via OpenRouter, then spoken back with ElevenLabs realistic TTS. No framework, no build step — just vanilla JS on both ends.

```
mic → Browser speech recognition (STT)
        → OpenRouter LLM (translation)
        → ElevenLabs TTS (voice synthesis)
        → Browser audio playback
```

**Both API keys live only on the server.** The browser never sees them.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+ (tested on 22)
- **Chrome or Edge** — the Web Speech API isn't available in Firefox
- An **OpenRouter API key** ([openrouter.ai/keys](https://openrouter.ai/keys))
- An **ElevenLabs API key** ([elevenlabs.io](https://elevenlabs.io))

## Setup

```bash
# 1. Clone or enter the project directory
cd translation-app

# 2. Create your environment file
cp .env.example .env

# 3. Add your API keys to .env
#    (never commit this file or paste keys in chat)
OPENROUTER_API_KEY=sk-or-v1-xxxxxxxxx
ELEVENLABS_API_KEY=xxxxxxxxx

# 4. Start the server
node server.js
#    or: npm start
```

Then open **http://localhost:3000** in Chrome or Edge. Tap anywhere on the page to start, and speak into your mic.

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `OPENROUTER_API_KEY` | yes | — | Translation (LLM) |
| `ELEVENLABS_API_KEY` | yes | — | Voice synthesis (TTS) |
| `ELEVENLABS_VOICE_ID` | no | `21m00Tcm4TlvDq8ikWAM` (Rachel) | Any ElevenLabs voice ID |
| `ELEVENLABS_MODEL` | no | `eleven_multilingual_v2` | Handles both English and Chinese |
| `OPENROUTER_MODEL` | no | `google/gemini-2.5-flash-preview` | Any OpenRouter chat model slug |
| `PORT` | no | `3000` | Listen port |

## Usage tips

- **Language ping-pong:** Each turn flips the expected language (EN→ZH, ZH→EN). Speak the language shown on screen.
- **Autoplay gesture:** Browsers require one tap or click before they'll play audio. The start overlay handles this.
- **Loop guard:** The mic stops while the translation is spoken so the app never hears its own voice.
- **Restart after any change:** The server doesn't auto-reload — you need to stop it (`Ctrl+C`) and start it again.

## Files

| File | Purpose |
|---|---|
| `server.js` | HTTP server with `/translate` and `/tts` proxy endpoints, static file serving |
| `public/index.html` | Single-page UI with tap-to-start, language indicator, transcript |
| `public/app.js` | Speech recognition, translation calls, audio playback, turn logic |
| `.env` | Your local API keys (not committed) |

## API endpoints

### `POST /translate`
- Request: `{ "text": "<recognized speech>" }`
- Response: `{ "source": "en"|"zh", "translation": "<translated text>" }`

### `POST /tts`
- Request: `{ "text": "<text to speak>" }`
- Response: `audio/mpeg` bytes
