# Realtime EN↔ZH Voice Translator — Self-hosted

A **no-button, realtime English ↔ Chinese voice translator** that runs entirely on your own hardware. Speak, hear translated audio — no cloud APIs, no third-party keys.

## Architecture

```
Browser (RTCPeerConnection)
   │  mic audio track (Opus)
   ▼
Gateway (Python + aiortc) — terminates WebRTC, VAD, resampling
   │  PCM16 16kHz utterance on speech end
   ▼
Model server (Qwen2.5-Omni on your GPU) — streams translation audio back
   │  text + PCM16 24kHz audio
   ▼
Gateway → remote audio track (Opus) → browser speakers
        → data channel (text) → transcript bubbles
```

- **Full-duplex:** the model can barge in / talk while you speak — the browser's WebRTC handles echo cancellation natively.
- **Turn-based translation:** VAD in the gateway detects utterance boundaries, sends the audio to the model, model generates translation.
- **One model to rule them all:** Qwen2.5-Omni handles STT + translation + TTS in a single forward pass. No Deepgram, no separate ASR/TTS models.

## Prerequisites

- **GPU box** with ~12–24GB VRAM (Qwen2.5-Omni-7B, or the 3B model for less)
- **macOS/Linux** machine for the gateway (can be the same box as the GPU)
- **Node.js** 18+ (for static file server and `/offer` proxy)
- **Python** 3.10+ for the gateway + model server

## Quick start (mock mode — no GPU needed)

```bash
# 1. Install dependencies
npm install                      # Node server
pip install -r gateway/requirements.txt   # Python gateway

# 2. Start the mock model server (no GPU, returns beeps + dummy text)
cd model && python server.py --mock &
cd ..

# 3. Start the gateway
cd gateway && python gateway.py &
cd ..

# 4. Start the Node server
npm start

# 5. Open http://localhost:3000 in any browser, tap to start
```

## Real deployment (with a GPU)

On the **GPU box**, run the actual Qwen2.5-Omni model:

```bash
pip install -r model/requirements.txt
python model/server.py --model Qwen/Qwen2.5-Omni-7B
```

The model server listens on `ws://0.0.0.0:8765`. The gateway connects to it via `MODEL_WS` env var.

Set environment variables:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | Node static server |
| `GATEWAY_URL` | `http://localhost:8080` | Where the gateway is listening |
| `MODEL_WS` | `ws://localhost:8765` | Model server WebSocket (set in gateway process) |
| `GATEWAY_PORT` | `8080` | Gateway listen port |
| `MODEL_PORT` | `8765` | Model server WebSocket port |

### Files

| File | Role |
|---|---|
| `gateway/gateway.py` | Python aiortc WebRTC terminator + VAD + model bridge |
| `gateway/requirements.txt` | pip deps for the gateway |
| `model/server.py` | Qwen2.5-Omni WS server (+ `--mock` for testing) |
| `model/requirements.txt` | pip deps for the model server |
| `public/index.html` | UI: overlay, pill, status, transcript |
| `public/app.js` | WebRTC client — offer, track, data channel |
| `server.js` | Static server + `/offer` proxy + `/api/config` |
| `metrics/` | SQLite-backed analytics (currently no-op; the model path doesn't send turn metrics) |

## How it works (end-to-end)

1. **Browser** captures mic → `RTCPeerConnection` → creates SDP offer
2. **Server** proxies the offer to the **gateway** → gateway creates a `RTCPeerConnection` on its side
3. **Gateway** receives the browser's audio track → **VAD** detects utterance boundaries → resamples 48k→16k → sends PCM to **model server** via WebSocket
4. **Model** (Qwen2.5-Omni) receives the audio, translates it, returns: `{type:"text",text:"..."}` + binary PCM16 24kHz audio
5. **Gateway** resamples 24k→48k → sends as a `MediaStreamTrack` back over WebRTC + forwards text via data channel
6. **Browser** plays the remote audio track (Opus, echo cancellation built-in) + shows translation bubbles

**Language toggle:** tapping the pill sends `{type:"language",lang:"en"|"zh"}` over the data channel → gateway → model server → model updates its system prompt.

## License

MIT