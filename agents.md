# agents.md — Realtime EN↔ZH Voice Translator (self-hosted)

Reference for any agent working in this repo.

## What this app is
A **no-button, realtime English ↔ Chinese voice translator** that runs on your own hardware.
You speak; translated audio plays back with the browser's echo cancellation. No cloud APIs,
no third-party keys. The only UI controls are a single tap-to-start overlay and a language pill.

## Architecture (current)
```
Browser (RTCPeerConnection) — mic + remote audio track + data channel
   │
   ▼
gateway/gateway.py  (Python + aiortc)  — WebRTC termination, VAD, resampling 48k↔16k/24k↔48k
   │  PCM16 16k utterance on VAD end  │  text + PCM16 24k audio
   ▼                                  ▲
model/server.py  (Qwen2.5-Omni on GPU) — translate: 16k audio → text + 24k audio
```

- **Full-duplex:** browser's WebRTC AEC cancels the model's output from the mic input,
  enabling barge-in. The model can be interrupted mid-turn.
- **Turn-based inference:** VAD in the gateway (webrtcvad, 300ms silence threshold) collects
  an utterance, sends to the model, model returns text + audio (single `generate` call).
  True chunked streaming is a future upgrade via vllm end2end.
- **One model:** Qwen2.5-Omni-7B (Apache-2.0, EN+ZH, 24kHz output). The 3B variant works
  with less GPU.

## Get running

```bash
# Terminal 1 — model (mock for now, no GPU)
cd model && python server.py --mock

# Terminal 2 — gateway
cd gateway && python gateway.py

# Terminal 3 — Node server
npm start

# Browser → http://localhost:3000
```

## Files
| File | Role |
|---|---|
| `server.js` | Node static server + `/offer` proxy (→ gateway) + `/api/config` |
| `public/index.html` | UI: overlay, pill, pulse, status, transcript |
| `public/app.js` | WebRTC client: getUserMedia → offer → track → data channel |
| `gateway/gateway.py` | Python aiortc gateway: RTCPeerConnection + VAD + model WS bridge |
| `gateway/requirements.txt` | pip packages for the gateway |
| `model/server.py` | Qwen2.5-Omni WS server (+ `--mock` for testing) |
| `model/requirements.txt` | pip packages for the model |
| `package.json` | `npm start` → builds metrics → `node server.js` |
| `metrics/` | SQLite metrics (vestigial, no-op in current architecture) |

## Component communication

### Browser ↔ Server / Gateway
- `GET /api/config` → returns `{ gateway: "http://localhost:8080" }`
- `POST /offer` (SDP body) → Node proxies to `gateway:8080/offer` → returns answer SDP
- WebRTC media: audio directly between browser and gateway (ICE candidates negotiated in SDP)
- Data channel: browser→gateway `{type:"language", lang:"en"|"zh"}`; gateway→browser `{type:"text", text:"…"}`

### Gateway ↔ Model Server
- Gateway opens one WebSocket per WebRTC session to `MODEL_WS` (default `ws://localhost:8765`)
- Gateway sends: binary PCM16 16kHz mono on speech end (utterance)
- Gateway sends: JSON `{type:"language", lang:"en"|"zh"}` on toggle
- Model sends: JSON `{type:"text", text:"…"}` (translation text)
- Model sends: binary PCM16 24kHz mono (translation audio, streamed back per utterance)

## Model server protocol
- Connect: `ws://host:8765`
- Config: gateway sends `{type:"language", lang:"zh"}` at any time
- Translation input: raw PCM16 s16 mono 16000Hz (binary WebSocket message)
- Translation output:
  1. `{type:"text", text:"translated sentence"}` (JSON)
  2. binary PCM16 s16 mono 24000Hz audio (binary message)
- History: the model server keeps conversation history per WebSocket connection

## Key design decisions

| Choice | Why |
|---|---|
| **VAD in gateway, not browser** | Cleaner API (browser just streams); webrtcvad is simple and works on raw PCM |
| **Simple decimation for 48k↔16k** | Every 3rd sample is fine for speech; Qwen processor resamples anyway |
| **No PyAV resampler** | `np.repeat(arr, 2)` for 24→48k, `arr[::3]` for 48→16k. ~4 lines, zero deps |
| **Turn-based model inference** | Qwen2.5-Omni's `model.generate` is a single call. Chunked streaming is a vllm upgrade path |
| **Two Python processes (gateway + model)** | Separation lets the GPU box run the model server headless while the gateway runs anywhere. Can be merged if desired. |
| **Full-duplex via WebRTC AEC** | Browser's built-in echo cancellation is the real reason to use WebRTC locally. Without it, full-duplex requires headphones or manual echo suppression |

## Verification

```bash
# Syntax checks
node --check server.js && node --check public/app.js
python -c "import ast; ast.parse(open('gateway/gateway.py').read()); print('gateway OK')"
python -c "import ast; ast.parse(open('model/server.py').read()); print('model OK')"

# Run mock + gateway + server, then verify
# open http://localhost:3000, tap, speak. You should hear a sine-wave beep as response.
```

## Failure modes

- **No audio plays:** check gateway is running (`python gateway/gateway.py`). Check model server (`python model/server.py --mock`). Check `POST /offer` in browser devtools.
- **Model not translating:** `MODEL_WS` points to a running model server. In mock mode it returns beeps + fixed text. In real mode, ensure GPU has enough VRAM.
- **Echo / feedback:** the browser's AEC should handle it. If you hear echo, ensure the browser isn't also locally monitoring the mic.
- **Latency:** first utterance loads the model into GPU memory (~10-60s). Subsequent utterances are fast (model.generate in ~200-500ms for short speech).

## History
1. **STT→LLM→TTS pipeline** (Deepgram + OpenRouter + ElevenLabs) — original shipped version
2. **OpenAI Realtime Translation** — experimental WebRTC branch, replaced by the current self-hosted approach
3. **Self-hosted WebRTC + Qwen2.5-Omni (current)** — full-duplex, no API keys, runs on your GPU