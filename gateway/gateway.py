"""WebRTC gateway: terminates browser WebRTC, bridges PCM to vllm-omni (OpenAI-compatible API)."""
import asyncio, base64, json, logging, os, struct
import numpy as np
import webrtcvad
import aiohttp
from aiohttp import web
from aiortc import RTCPeerConnection, RTCSessionDescription, MediaStreamTrack
from aiortc.mediastreams import AudioFrame

VLLM_URL = os.environ.get('VLLM_URL', 'http://localhost:8765/v1')
VLLM_MODEL = os.environ.get('VLLM_MODEL', 'Qwen/Qwen2.5-Omni-7B')
GATEWAY_PORT = int(os.environ.get('GATEWAY_PORT', '8080'))

log = logging.getLogger('gateway')
pcs = set()

# ── WAV helpers (zero deps, stdlib only) ────────────────────────────────────

def pcm16_to_wav(pcm16: bytes, rate: int = 16000) -> bytes:
    """Raw PCM16 mono → WAV bytes (44-byte header + data)."""
    n = len(pcm16)
    header = struct.pack('<4sI4s4sIHHIIHH4sI',
        b'RIFF', 36 + n, b'WAVE',
        b'fmt ', 16, 1, 1, rate, rate * 2, 2, 16,
        b'data', n)
    return header + pcm16

def wav_to_pcm16(wav: bytes) -> tuple[bytes, int]:
    """WAV bytes → (PCM16 mono, sample_rate)."""
    rate = struct.unpack_from('<I', wav, 24)[0]
    data_size = struct.unpack_from('<I', wav, 40)[0]
    return wav[44:44 + data_size], rate

# ── Model client (vllm-omni OpenAI-compatible HTTP API) ─────────────────────

class ModelClient:
    """HTTP client for vllm-omni /v1/chat/completions.  One per WebRTC session."""

    SYSTEM_PROMPT = (
        'You are a simultaneous interpreter between English and Chinese. '
        'Detect which language the user is speaking and translate it into the other language. '
        'If they speak English, output Chinese. If they speak Chinese, output English. '
        'Output only the translation, nothing else. Speak naturally and briefly.'
    )

    def __init__(self, base_url: str, model: str):
        self.base_url = base_url.rstrip('/')
        self.model = model
        self.session = aiohttp.ClientSession()
        self.history: list[dict] = []  # conversation history (excl. system)

    async def translate(self, pcm16k: bytes) -> tuple[str, bytes]:
        """Send 16k PCM16 audio → (translation text, 24k PCM16 audio)."""
        # Encode as WAV → base64 data URI
        wav = pcm16_to_wav(pcm16k, 16000)
        b64 = base64.b64encode(wav).decode()

        messages = [
            {'role': 'system', 'content': [{'type': 'text', 'text': self.SYSTEM_PROMPT}]},
            *self.history,
            {'role': 'user', 'content': [
                {'type': 'audio_url', 'audio_url': {'url': f'data:audio/wav;base64,{b64}'}},
            ]},
        ]

        body = {'model': self.model, 'messages': messages, 'modalities': ['audio']}

        async with self.session.post(f'{self.base_url}/chat/completions', json=body) as resp:
            data = await resp.json()

        text = ''
        audio_b64 = ''
        for choice in data.get('choices', []):
            msg = choice.get('message', {})
            if msg.get('content'):
                text = msg['content']
            if msg.get('audio'):
                audio_b64 = msg['audio'].get('data', '')

        # Update conversation history
        self.history.append({'role': 'user', 'content': [{'type': 'audio', 'audio': None}]})
        self.history.append({'role': 'assistant', 'content': [{'type': 'text', 'text': text}]})

        # Decode audio (WAV → PCM16)
        pcm = b''
        if audio_b64:
            wav_out = base64.b64decode(audio_b64)
            pcm, sr = wav_to_pcm16(wav_out)
            if sr != 24000:
                log.warning('model returned audio at %d Hz, expected 24000', sr)
        return text, pcm

    async def close(self):
        await self.session.close()

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
                    if self._misses >= 10:       # ~200ms silence → end
                        self._end()
                else:
                    self._misses = 0

    def _end(self):
        if len(self._speech) > 3200:             # >100ms minimum
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
                self._buf += self._queue.get_nowait()
            except asyncio.QueueEmpty:
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

    model_client = None
    translate_task = None
    vad = VAD()
    dc = None  # browser data channel

    async def translate(speech: bytes):
        nonlocal dc, outbound, model_client
        try:
            text, pcm24k = await model_client.translate(speech)
            if text and dc:
                try:
                    dc.send(json.dumps({'type': 'text', 'text': text}))
                except Exception:
                    pass
            if pcm24k:
                outbound.push(to_48k(pcm24k))
        except asyncio.CancelledError:
            pass  # barge-in interrupted this utterance
        except Exception as e:
            log.error('translate: %s', e)
            if dc:
                try:
                    dc.send(json.dumps({'type': 'error', 'text': 'Translation failed'}))
                except Exception:
                    pass

    async def on_speech_end(speech: bytes):
        nonlocal translate_task, model_client
        if not model_client or len(speech) <= 3200:
            return
        # Cancel any in-flight translation so the new utterance takes priority
        if translate_task and not translate_task.done():
            translate_task.cancel()
        translate_task = asyncio.create_task(translate(speech))

    vad.on_speech_end = on_speech_end

    @pc.on('track')
    async def on_track(track):
        nonlocal model_client
        if track.kind != 'audio':
            return
        model_client = ModelClient(VLLM_URL, VLLM_MODEL)
        while True:
            try:
                frame = await track.recv()
            except Exception:
                break
            if frame.rate != 48000 or frame.layout.name != 'mono':
                continue
            pcm48 = frame.to_ndarray().tobytes()  # (1, 960) → 1920 bytes
            vad.feed(to_16k(pcm48))

    @pc.on('datachannel')
    def on_datachannel(channel):
        nonlocal dc
        dc = channel

    @pc.on('connectionstatechange')
    async def on_conn_state():
        if pc.connectionState in ('failed', 'closed'):
            if model_client:
                await model_client.close()
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
    log.info('gateway :%d → vllm-omni %s (%s)', GATEWAY_PORT, VLLM_URL, VLLM_MODEL)
    web.run_app(app, port=GATEWAY_PORT, access_log=None)