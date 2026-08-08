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
   │  PCM16 16k utterance as WAV base64 (HTTP POST)  │  text + PCM16 24k audio
   ▼                                                ▲
vllm-omni (OpenAI-compatible API)  — Qwen2.5-Omni serving (continuous batching)
```

- **Full-duplex:** browser's WebRTC AEC cancels the model's output from the mic input,
  enabling barge-in. The model can be interrupted mid-turn.
- **Turn-based inference:** VAD in the gateway (webrtcvad, 200ms silence threshold) collects
  an utterance, sends to vllm-omni via HTTP, gets text + audio back.
  True chunked streaming is a future upgrade via vllm end2end.
- **One model:** Qwen2.5-Omni-7B (Apache-2.0, EN+ZH, 24kHz output). The 3B variant works
  with less GPU.
- **vllm-omni**: [vllm-project/vllm-omni](https://github.com/vllm-project/vllm-omni) serves
  Qwen2.5-Omni via an OpenAI-compatible `/v1/chat/completions` endpoint.  Replaces the old
  custom `model/server.py` WebSocket server.  Enables continuous batching and text streaming.

## Get running

```bash
# Terminal 1 — model (vllm-omni, requires GPU)
pip install vllm-omni
vllm serve Qwen/Qwen2.5-Omni-7B --omni --port 8765

# Terminal 2 — gateway
cd gateway && python gateway.py

# Terminal 3 — Node server
npm start

# Browser → http://localhost:3000

# For testing without a GPU, use the old mock server:
# cd model && python server.py --mock
```

## Files
| File | Role |
|---|---|
| `server.js` | Node static server + `/offer` proxy (→ gateway) + `/api/config` |
| `public/index.html` | UI: overlay, pill, pulse, status, transcript |
| `public/app.js` | WebRTC client: getUserMedia → offer → track → data channel |
| `gateway/gateway.py` | Python aiortc gateway: RTCPeerConnection + VAD + vllm-omni HTTP client |
| `gateway/requirements.txt` | pip packages for the gateway |
| `model/server.py` | Qwen2.5-Omni WS server (deprecated, use vllm-omni instead; `--mock` for testing) |
| `model/requirements.txt` | pip packages for the model server (only if not using vllm-omni) |
| `package.json` | `npm start` → builds metrics → `node server.js` |
| `metrics/` | SQLite metrics (vestigial, no-op in current architecture) |

## Component communication

### Browser ↔ Server / Gateway
- `GET /api/config` → returns `{ gateway: "http://localhost:8080" }`
- `POST /offer` (SDP body) → Node proxies to `gateway:8080/offer` → returns answer SDP
- WebRTC media: audio directly between browser and gateway (ICE candidates negotiated in SDP)
- Data channel: browser→gateway `{type:"language", lang:"en"|"zh"}`; gateway→browser `{type:"text", text:"…"}`

### Gateway ↔ vllm-omni
- Gateway sends HTTP POST to `VLLM_URL` (default `http://localhost:8765/v1/chat/completions`)
- Request body: OpenAI-compatible JSON with base64-encoded WAV audio + `modalities: ["audio"]`
- Response: `choices[].message.content` (text) + `choices[].message.audio.data` (base64 WAV)
- Gateway manages conversation history per session (no persistent connection)

## Key design decisions

| Choice | Why |
|---|---|
| **VAD in gateway, not browser** | Cleaner API (browser just streams); webrtcvad is simple and works on raw PCM |
| **Simple decimation for 48k↔16k** | Every 3rd sample is fine for speech; Qwen processor resamples anyway |
| **No PyAV resampler** | `np.repeat(arr, 2)` for 24→48k, `arr[::3]` for 48→16k. ~4 lines, zero deps |
| **Turn-based model inference** | Qwen2.5-Omni's `model.generate` is a single call. Chunked streaming is a vllm upgrade path |
| **vllm-omni for serving** | OpenAI-compatible API, continuous batching, text streaming, replaces custom model server |
| **Full-duplex via WebRTC AEC** | Browser's built-in echo cancellation is the real reason to use WebRTC locally. Without it, full-duplex requires headphones or manual echo suppression |

## Verification

```bash
# Syntax checks
node --check server.js && node --check public/app.js
python -c "import ast; ast.parse(open('gateway/gateway.py').read()); print('gateway OK')"

# Run vllm-omni + gateway + server, then verify
# open http://localhost:3000, tap, speak. You should hear translated audio.
```

## Failure modes

- **No audio plays:** check gateway is running (`python gateway/gateway.py`). Check vllm-omni is running (`vllm serve Qwen/Qwen2.5-Omni-7B --omni --port 8765`). Check `POST /offer` in browser devtools.
- **Model not translating:** `VLLM_URL` points to a running vllm-omni server. Ensure GPU has enough VRAM (requires 4x L4 or equivalent for 7B).
- **Echo / feedback:** the browser's AEC should handle it. If you hear echo, ensure the browser isn't also locally monitoring the mic.
- **Latency:** first utterance loads the model into GPU memory (~10-60s). Subsequent utterances are fast (model.generate in ~200-500ms for short speech). Try the 3B model for 2-3x faster inference: `VLLM_MODEL=Qwen/Qwen2.5-Omni-3B`.

## History
1. **STT→LLM→TTS pipeline** (Deepgram + OpenRouter + ElevenLabs) — original shipped version
2. **OpenAI Realtime Translation** — experimental WebRTC branch, replaced by the current self-hosted approach
3. **Self-hosted WebRTC + Qwen2.5-Omni (current)** — full-duplex, no API keys, runs on your GPU