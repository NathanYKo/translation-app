"""Model server: wraps Qwen2.5-Omni behind a WebSocket.  Run with --mock to test without GPU."""
import argparse, asyncio, json, os, tempfile
import numpy as np
import websockets

# Auto ping-pong: detect source language, translate to the other one.
SYSTEM_PROMPT = (
    'You are a simultaneous interpreter between English and Chinese. '
    'Detect which language the user is speaking and translate it into the other language. '
    'If they speak English, output Chinese. If they speak Chinese, output English. '
    'Output only the translation, nothing else. Speak naturally and briefly.'
)

# ── Omni session (runs on GPU) ──────────────────────────────────────────────

class OmniSession:
    def __init__(self, model, processor):
        self.model = model
        self.processor = processor
        self.history = []

    def translate(self, pcm16k: bytes, sample_rate=16000):
        """Returns (text, audio_24k_float). Takes 16k s16 mono PCM."""
        audio = np.frombuffer(pcm16k, dtype=np.int16).astype(np.float32) / 32768.0

        # write to temp WAV — Qwen processor expects file paths
        tmp = tempfile.NamedTemporaryFile(suffix='.wav', delete=False)
        import soundfile as sf
        sf.write(tmp.name, audio, sample_rate, format='WAV')
        tmp.close()

        messages = [{"role": "system", "content": [{"type": "text", "text": SYSTEM_PROMPT}]}]
        for h in self.history:
            messages.append(h)
        messages.append({"role": "user", "content": [{"type": "audio", "audio": tmp.name}]})

        from qwen_omni_utils import process_mm_info
        audios, images, videos = process_mm_info(messages, use_audio_in_video=True)
        text = self.processor.apply_chat_template(messages, add_generation_prompt=True, tokenize=False)
        inputs = self.processor(text=text, audio=audios, images=images, videos=videos,
                                return_tensors='pt', padding=True, use_audio_in_video=True)
        inputs = inputs.to(self.model.device).to(self.model.dtype)

        text_ids, audio_out = self.model.generate(**inputs, speaker='Chelsie', use_audio_in_video=True)
        response = self.processor.batch_decode(text_ids, skip_special_tokens=True, clean_up_tokenization_spaces=False)
        response = response[0].split('\n')[-1].strip()

        os.unlink(tmp.name)

        # Update history for next turn
        self.history.append({"role": "user", "content": [{"type": "audio", "audio": None}]})
        self.history.append({"role": "assistant", "content": [{"type": "text", "text": response}]})

        return response, audio_out  # audio_out is 24k float

# ── Mock session (no GPU) ──────────────────────────────────────────────────

class MockSession:
    """Returns dummy text + sine wave for testing the pipeline."""
    def translate(self, pcm16k: bytes, sample_rate=16000):
        dur = max(0.3, len(pcm16k) / 32000)  # ~seconds of audio
        t = np.arange(int(24_000 * dur)) / 24_000
        audio = (np.sin(2 * np.pi * 440 * t) * 0.25 +
                 np.sin(2 * np.pi * 660 * t) * 0.15).astype(np.float32)
        text = f'(auto) mock translation heard {len(pcm16k)//32}ms of speech'
        return text, audio

# ── WebSocket handler ───────────────────────────────────────────────────────

async def handle(ws, session_cls):
    session = session_cls()
    async for msg in ws:
        if isinstance(msg, str):
            continue  # ignore any config messages
        try:
            text, audio = session.translate(msg)
        except Exception as e:
            print(f'[model] translate error: {e}')
            continue
        await ws.send(json.dumps({'type': 'text', 'text': text}))
        # audio is float32 24k → s16
        audio_s16 = np.clip(audio * 32767, -32768, 32767).astype(np.int16).tobytes()
        await ws.send(audio_s16)

# ── Main ────────────────────────────────────────────────────────────────────

async def main():
    parser = argparse.ArgumentParser(description='Qwen2.5-Omni model server (or mock)')
    parser.add_argument('--model', default='Qwen/Qwen2.5-Omni-7B', help='HF model name or path')
    parser.add_argument('--mock', action='store_true', help='Run mock server (no GPU required)')
    parser.add_argument('--port', type=int, default=8765, help='WebSocket listen port')
    args = parser.parse_args()

    if args.mock:
        print(f'[model] mock server on :{args.port}')
        h = lambda ws: handle(ws, MockSession)
    else:
        from transformers import Qwen2_5OmniForConditionalGeneration, Qwen2_5OmniProcessor
        print(f'[model] loading {args.model}…')
        model = Qwen2_5OmniForConditionalGeneration.from_pretrained(
            args.model, device_map='auto', torch_dtype='auto')
        processor = Qwen2_5OmniProcessor.from_pretrained(args.model)
        print('[model] loaded')
        h = lambda ws: handle(ws, lambda: OmniSession(model, processor))

    async with websockets.serve(h, '0.0.0.0', args.port, max_size=20 * 10**6):
        print(f'[model] listening on ws://0.0.0.0:{args.port}')
        await asyncio.Future()

if __name__ == '__main__':
    asyncio.run(main())