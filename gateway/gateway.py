"""WebRTC gateway: terminates browser WebRTC, bridges PCM to Qwen2.5-Omni model server."""
import asyncio, json, logging, os, time
import numpy as np
import webrtcvad
import websockets
from aiohttp import web
from aiortc import RTCPeerConnection, RTCSessionDescription, MediaStreamTrack
from aiortc.mediastreams import AudioFrame

MODEL_WS = os.environ.get('MODEL_WS', 'ws://localhost:8765')
GATEWAY_PORT = int(os.environ.get('GATEWAY_PORT', '8080'))

log = logging.getLogger('gateway')
pcs = set()

# ── VAD (voice activity detection) ──────────────────────────────────────────

class VAD:
    """Energy + webrtcvad hybrid. Feed 20ms frames (320 bytes s16 mono 16k)."""
    def __init__(self):
        self.vad = webrtcvad.Vad(1)
        self._buf = bytearray()
        self._speech = bytearray()
        self._state = 'idle'          # idle | speech | releasing
        self._hits = 0
        self._misses = 0
        self.on_speech_end = None     # callback(bytes)

    def feed(self, pcm16_bytes: bytes):
        self._buf.extend(pcm16_bytes)
        while len(self._buf) >= 320:
            chunk = bytes(self._buf[:320])
            del self._buf[:320]
            voiced = self.vad.is_speech(chunk, 16000)

            if self._state == 'idle':
                if voiced:
                    self._hits += 1
                    if self._hits >= 3:          # 3 voiced frames → speech start
                        self._state = 'speech'
                        self._speech = bytearray(chunk)
                        self._misses = 0
                else:
                    self._hits = 0

            elif self._state == 'speech':
                self._speech.extend(chunk)
                if not voiced:
                    self._misses += 1
                    if self._misses >= 15:       # ~300ms silence → end
                        self._end()
                else:
                    self._misses = 0

    def _end(self):
        if len(self._speech) > 3200:             # >200ms minimum
            cb = self.on_speech_end
            if cb:
                cb(bytes(self._speech))
        self._speech = bytearray()
        self._hits = 0
        self._misses = 0
        self._state = 'idle'

    def reset(self):
        self._state = 'idle'
        self._speech = bytearray()
        self._hits = 0
        self._misses = 0
        self._buf = bytearray()

# ── Outbound audio track (model → browser) ──────────────────────────────────

class OutboundAudio(MediaStreamTrack):
    kind = 'audio'

    def __init__(self):
        super().__init__()
        self._queue = asyncio.Queue()
        self._buf = bytearray()

    def push(self, pcm48k: bytes):
        self._queue.put_nowait(pcm48k)

    async def recv(self):
        # aiortc pulls 20ms frames: 960 samples @ 48k = 1920 bytes
        while len(self._buf) < 1920:
            try:
                self._buf += await asyncio.wait_for(self._queue.get(), timeout=0.5)
            except asyncio.TimeoutError:
                break
        if len(self._buf) < 1920:
            self._buf += b'\x00' * (1920 - len(self._buf))
        data = bytes(self._buf[:1920])
        del self._buf[:1920]
        arr = np.frombuffer(data, dtype=np.int16).reshape(1, 960)
        frame = AudioFrame.from_ndarray(arr, format='s16', layout='mono')
        frame.rate = 48000
        return frame

# ── Resampling (zero-alloc, no PyAV needed) ─────────────────────────────────

def to_16k(pcm48k: bytes) -> bytes:
    """48k s16 mono → 16k s16 mono via decimation (every 3rd sample)."""
    arr = np.frombuffer(pcm48k, dtype=np.int16)
    # pad to multiple of 3
    r = len(arr) % 3
    if r:
        arr = arr[:-r]
    return arr[::3].tobytes()

def to_48k(pcm24k: bytes) -> bytes:
    """24k s16 mono → 48k s16 mono via sample doubling."""
    return np.repeat(np.frombuffer(pcm24k, dtype=np.int16), 2).tobytes()

# ── WebRTC session handler ──────────────────────────────────────────────────

async def handle_offer(request):
    body = await request.text()
    pc = RTCPeerConnection()
    pcs.add(pc)

    outbound = OutboundAudio()
    pc.addTrack(outbound)

    model_ws = None
    vad = VAD()
    dc = None  # browser data channel

    async def model_connect():
        nonlocal model_ws
        try:
            model_ws = await websockets.connect(MODEL_WS, max_size=20 * 10**6)
            asyncio.ensure_future(model_reader())
        except Exception as e:
            log.error('model connect failed: %s', e)
            if dc:
                try:
                    dc.send(json.dumps({'type': 'error', 'text': 'Model server unavailable'}))
                except Exception:
                    pass

    async def model_reader():
        nonlocal model_ws, dc
        try:
            async for msg in model_ws:
                if isinstance(msg, str):
                    ev = json.loads(msg)
                    if ev.get('type') == 'text' and dc:
                        dc.send(json.dumps(ev))
                else:
                    outbound.push(to_48k(msg))
        except Exception as e:
            log.error('model reader: %s', e)

    async def on_speech_end(speech: bytes):
        nonlocal model_ws
        if model_ws and len(speech) > 3200:
            try:
                await model_ws.send(speech)
            except Exception as e:
                log.error('send to model: %s', e)

    vad.on_speech_end = on_speech_end

    @pc.on('track')
    async def on_track(track):
        if track.kind != 'audio':
            return
        await model_connect()
        while True:
            try:
                frame = await track.recv()
            except Exception:
                break
            # frame is 48k s16 mono, 960 samples
            if frame.rate != 48000 or frame.layout.name != 'mono':
                continue
            pcm48 = frame.to_ndarray().tobytes()  # (1, 960) → 1920 bytes
            vad.feed(to_16k(pcm48))

    @pc.on('datachannel')
    def on_datachannel(channel):
        nonlocal dc
        dc = channel
        # ponytail: no language messages needed — model auto-detects source language

    @pc.on('connectionstatechange')
    async def on_conn_state():
        if pc.connectionState in ('failed', 'closed'):
            if model_ws:
                await model_ws.close()
            pcs.discard(pc)
            await pc.close()

    await pc.setRemoteDescription(RTCSessionDescription(sdp=body, type='offer'))
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    return web.Response(content_type='application/sdp', text=answer.sdp)

# ── HTTP server ─────────────────────────────────────────────────────────────

async def on_shutdown(app):
    for pc in list(pcs):
        await pc.close()

async def health(request):
    return web.json_response({'ok': True, 'connections': len(pcs)})

app = web.Application()
app.router.add_post('/offer', handle_offer)
app.router.add_get('/health', health)
app.on_shutdown.append(on_shutdown)

if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(name)s] %(levelname)s %(message)s')
    log.info('gateway :%d → model %s', GATEWAY_PORT, MODEL_WS)
    web.run_app(app, port=GATEWAY_PORT, access_log=None)