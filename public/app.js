// Realtime English<->Chinese voice translator
// Streaming STT (Deepgram via WebSocket) + OpenRouter LLM + Streaming TTS (ElevenLabs)

const overlay = document.getElementById('start');
const langEl = document.getElementById('lang');
const statusEl = document.getElementById('status');
const interimEl = document.getElementById('interim');
const transcriptEl = document.getElementById('transcript');
const pulseEl = document.querySelector('.pulse');
const logEl = document.getElementById('log');
const bodyEl = document.body;

function log(msg) {
  const t = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  line.textContent = `[${t}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  console.log(`[translator] ${msg}`);
}

function setState(s, text) {
  bodyEl.dataset.state = s;
  if (text != null) statusEl.textContent = text;
}

const params = new URLSearchParams(location.search);
let expectLang = params.get('lang') === 'zh' ? 'zh' : 'en';
let speaking = false;
let started = false;
let translateToken = 0;
let currentAudio = null;
let paused = false;

// MediaRecorder state
let mediaStream = null;
let mediaRecorder = null;
let audioChunks = [];
let audioCtx = null;
let analyser = null;
let vadRAF = null;

// Streaming STT state
let wsStt = null;
let wsTranscript = '';
let wsResolve = null;

function updateLangUI() {
  const isEn = expectLang === 'en';
  langEl.textContent = isEn ? 'Now speak: English · tap to switch' : 'Now speak: Chinese · tap to switch';
  langEl.className = isEn ? 'en' : 'zh';
}

function toggleLang() {
  expectLang = expectLang === 'en' ? 'zh' : 'en';
  updateLangUI();
  log('Language switched to: ' + expectLang);
}

langEl.addEventListener('click', toggleLang);

function togglePause() {
  if (!started) return;
  paused = !paused;
  if (paused) {
    cancelAnimationFrame(vadRAF);
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      try { mediaRecorder.stop(); } catch {}
    }
    audioChunks = [];
    if (wsStt && wsStt.readyState === WebSocket.OPEN) wsStt.close();
    wsStt = null;
    pulseEl.style.setProperty('--vol', 0);
    setState('paused', 'Paused — click the circle to resume');
    interimEl.textContent = '';
    interimEl.classList.remove('active');
    log('Paused');
  } else {
    log('Resumed');
    startRecordingCycleStreaming();
  }
}

pulseEl.addEventListener('click', togglePause);

// Real-time volume animation
let volumeRAF = null;
function volumeLoop() {
  if (!started || paused) { pulseEl.style.setProperty('--vol', 0); return; }
  const vol = getVolume();
  const prev = parseFloat(pulseEl.style.getPropertyValue('--vol')) || 0;
  const smoothed = prev * 0.6 + vol * 0.4;
  pulseEl.style.setProperty('--vol', smoothed.toFixed(3));
  volumeRAF = requestAnimationFrame(volumeLoop);
}

function addTurn(side, lang, text) {
  const wrap = document.createElement('div');
  wrap.className = 'turn ' + side;
  const who = document.createElement('div');
  who.className = 'who';
  const label = lang === 'en' ? 'English' : 'Chinese';
  who.textContent = side === 'you' ? `You (${label})` : `Translation (${label})`;
  const body = document.createElement('div');
  body.className = 'body';
  body.textContent = text;
  wrap.appendChild(who);
  wrap.appendChild(body);
  transcriptEl.appendChild(wrap);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// ── VAD ─────────────────────────────────────────────────────────────────────

function getVolume() {
  if (!analyser) return 0;
  const buf = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / buf.length);
}

const VAD_THRESHOLD = 0.04;
const SILENCE_MS = 800;          // ↓ from 1500 — saves ~700ms per turn
const MIN_SPEECH_MS = 400;
const MIN_BLOB_BYTES = 3000;
const NO_SPEECH_TIMEOUT = 30000;

// ── Streaming STT (WebSocket) ───────────────────────────────────────────────

function connectSttWebSocket() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`/ws?lang=${expectLang}`);

    ws.onopen = () => {
      log('STT WebSocket connected');
      resolve(ws);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'transcript') {
          interimEl.textContent = data.text;
          interimEl.classList.add('active');
          if (data.isFinal) wsTranscript = data.text;
        } else if (data.type === 'final') {
          wsTranscript = data.text;
          if (wsResolve) { wsResolve(wsTranscript); wsResolve = null; }
        } else if (data.type === 'error') {
          log('STT WS error: ' + data.error);
          if (wsResolve) { wsResolve(null); wsResolve = null; }
        }
      } catch {}
    };

    ws.onerror = () => {
      log('STT WS connection error');
      reject(new Error('WebSocket error'));
    };

    ws.onclose = () => {
      if (wsResolve) { wsResolve(wsTranscript || null); wsResolve = null; }
    };

    wsStt = ws;
  });
}

// ── Batch STT fallback ──────────────────────────────────────────────────────

function startRecordingCycle() {
  if (speaking || paused) return;
  audioChunks = [];
  interimEl.textContent = '';
  interimEl.classList.remove('active');

  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus' : 'audio/webm';

  try {
    mediaRecorder = new MediaRecorder(mediaStream, { mimeType });
  } catch (err) {
    log('MediaRecorder error: ' + err.message);
    setState('error', 'Cannot record audio. Check mic permissions.');
    return;
  }

  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
  mediaRecorder.onstop = onRecordingStop;
  mediaRecorder.start(100);

  let speechStarted = false;
  let speechStartTime = 0;
  let lastSpeechTime = 0;
  let recordingStartTime = Date.now();

  function vadLoop() {
    if (speaking) return;
    const vol = getVolume();
    const now = Date.now();
    if (vol > VAD_THRESHOLD) {
      lastSpeechTime = now;
      if (!speechStarted) {
        speechStarted = true;
        speechStartTime = now;
        setState('hearing', 'Hearing you…');
        interimEl.textContent = '…';
        interimEl.classList.add('active');
        log('Speech detected (vol=' + vol.toFixed(3) + ')');
      }
      vadRAF = requestAnimationFrame(vadLoop);
      return;
    }
    if (speechStarted) {
      if (now - lastSpeechTime > SILENCE_MS) {
        const speechDuration = lastSpeechTime - speechStartTime;
        if (speechDuration < MIN_SPEECH_MS) {
          log('Speech too short (' + speechDuration + 'ms), ignoring');
          speechStarted = false;
          vadRAF = requestAnimationFrame(vadLoop);
          return;
        }
        log('Silence after ' + speechDuration + 'ms of speech — stopping');
        interimEl.textContent = '';
        interimEl.classList.remove('active');
        try { mediaRecorder.stop(); } catch {}
        return;
      }
    } else {
      if (now - recordingStartTime > NO_SPEECH_TIMEOUT) {
        log('No speech for 30s — restarting idle');
        try { mediaRecorder.stop(); } catch {}
        return;
      }
    }
    vadRAF = requestAnimationFrame(vadLoop);
  }

  setState('listening', 'Listening — speak now');
  log('Listening (batch)…');
  vadRAF = requestAnimationFrame(vadLoop);
}

async function onRecordingStop() {
  cancelAnimationFrame(vadRAF);
  const blob = new Blob(audioChunks, { type: 'audio/webm' });
  audioChunks = [];
  if (blob.size < MIN_BLOB_BYTES) {
    log('Audio too small (' + blob.size + ' bytes) — skipping');
    startRecordingCycle();
    return;
  }
  setState('translating', 'Transcribing…');
  log('Sending ' + blob.size + ' bytes to Deepgram (batch)…');
  try {
    const resp = await fetch('/stt?lang=' + expectLang, { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: blob });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) { log('STT error: ' + (data.error || resp.status)); startRecordingCycle(); return; }
    const transcript = (data.transcript || '').trim();
    if (!transcript) { log('Empty transcript — skipping'); startRecordingCycle(); return; }
    log('Transcript: "' + transcript + '"');
    handleUtterance(transcript);
  } catch (err) {
    log('STT fetch error: ' + err.message);
    startRecordingCycle();
  }
}

// ── Streaming STT recording cycle ───────────────────────────────────────────

function startRecordingCycleStreaming() {
  if (speaking || paused) return;
  audioChunks = [];
  wsTranscript = '';
  interimEl.textContent = '';
  interimEl.classList.remove('active');

  connectSttWebSocket().then(ws => {
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus' : 'audio/webm';

    try {
      mediaRecorder = new MediaRecorder(mediaStream, { mimeType });
    } catch (err) {
      log('MediaRecorder error: ' + err.message);
      setState('error', 'Cannot record audio.');
      ws.close();
      return;
    }

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0 && ws.readyState === WebSocket.OPEN) {
        e.data.arrayBuffer().then(buf => ws.send(buf));
      }
    };

    mediaRecorder.onstop = () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stop' }));
      const p = new Promise(resolve => {
        wsResolve = resolve;
        setTimeout(() => { if (wsResolve === resolve) { wsResolve = null; resolve(wsTranscript || null); } }, 5000);
      });
      p.then(transcript => {
        ws.close();
        wsStt = null;
        if (transcript && transcript.trim()) {
          log('Transcript: "' + transcript + '"');
          handleUtterance(transcript);
        } else {
          log('Empty transcript — skipping');
          startRecordingCycleStreaming();
        }
      });
    };

    mediaRecorder.start(100);

    let speechStarted = false;
    let speechStartTime = 0;
    let lastSpeechTime = 0;
    let recordingStartTime = Date.now();

    function vadLoop() {
      if (speaking) return;
      const vol = getVolume();
      const now = Date.now();
      if (vol > VAD_THRESHOLD) {
        lastSpeechTime = now;
        if (!speechStarted) {
          speechStarted = true;
          speechStartTime = now;
          setState('hearing', 'Hearing you…');
          interimEl.textContent = '…';
          interimEl.classList.add('active');
          log('Speech detected (vol=' + vol.toFixed(3) + ')');
        }
        vadRAF = requestAnimationFrame(vadLoop);
        return;
      }
      if (speechStarted) {
        if (now - lastSpeechTime > SILENCE_MS) {
          const dur = lastSpeechTime - speechStartTime;
          if (dur < MIN_SPEECH_MS) {
            log('Speech too short (' + dur + 'ms), ignoring');
            speechStarted = false;
            vadRAF = requestAnimationFrame(vadLoop);
            return;
          }
          log('Silence after ' + dur + 'ms of speech — stopping');
          interimEl.textContent = '';
          interimEl.classList.remove('active');
          try { mediaRecorder.stop(); } catch {}
          return;
        }
      } else {
        if (now - recordingStartTime > NO_SPEECH_TIMEOUT) {
          log('No speech for 30s — restarting idle');
          try { mediaRecorder.stop(); } catch {}
          return;
        }
      }
      vadRAF = requestAnimationFrame(vadLoop);
    }

    setState('listening', 'Listening — speak now');
    log('Listening (streaming)…');
    vadRAF = requestAnimationFrame(vadLoop);

  }).catch(err => {
    log('Streaming STT unavailable, falling back to batch: ' + err.message);
    startRecordingCycle();
  });
}

// ── Translation + TTS ───────────────────────────────────────────────────────

async function handleUtterance(text) {
  const spokeLang = expectLang;
  addTurn('you', spokeLang, text);
  setState('translating', 'Translating…');
  const token = ++translateToken;
  try {
    const resp = await fetch('/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) console.error('Translate error:', resp.status, data);
    if (token !== translateToken) return;
    const translation = (data.translation || '').trim();
    if (!translation) { startRecordingCycleStreaming(); return; }
    const outLang = /[一-鿿]/.test(translation) ? 'zh' : 'en';
    addTurn('trans', outLang, translation);
    speakStreaming(translation, outLang, () => {
      speaking = false;
      startRecordingCycleStreaming();
    });
  } catch (err) {
    console.error('Translation error:', err);
    addTurn('trans', expectLang === 'en' ? 'zh' : 'en', '(translation error)');
    speaking = false;
    startRecordingCycleStreaming();
  }
}

function stopCurrentAudio() {
  if (currentAudio) {
    try { currentAudio.pause(); } catch {}
    try { URL.revokeObjectURL(currentAudio.src); } catch {}
    currentAudio = null;
  }
  try { speechSynthesis.cancel(); } catch {}
}

// ── Streaming TTS (MediaSource) ─────────────────────────────────────────────

async function speakStreaming(text, lang, onDone) {
  speaking = true;
  setState('speaking', 'Speaking…');
  stopCurrentAudio();

  if (!window.MediaSource || !MediaSource.isTypeSupported('audio/mpeg')) {
    log('MediaSource not available, using batch TTS');
    speak(text, lang, onDone);
    return;
  }

  try {
    const mediaSource = new MediaSource();
    const audio = new Audio();
    audio.src = URL.createObjectURL(mediaSource);
    currentAudio = audio;

    mediaSource.addEventListener('sourceopen', async () => {
      try {
        const sb = mediaSource.addSourceBuffer('audio/mpeg');
        const resp = await fetch('/tts-stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        if (!resp.ok) throw new Error('TTS stream HTTP ' + resp.status);

        const reader = resp.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (sb.updating) await new Promise(r => sb.addEventListener('updateend', r, { once: true }));
          sb.appendBuffer(value);
        }
        if (sb.updating) await new Promise(r => sb.addEventListener('updateend', r, { once: true }));
        mediaSource.endOfStream();

        audio.onended = () => { stopCurrentAudio(); onDone(); };
        audio.onerror = () => { stopCurrentAudio(); onDone(); };
        await audio.play();
        log('Playing via streaming ElevenLabs');
      } catch (err) {
        log('Streaming TTS error, falling back: ' + err.message);
        stopCurrentAudio();
        speak(text, lang, onDone);
      }
    });
  } catch (err) {
    log('MediaSource error, falling back: ' + err.message);
    speak(text, lang, onDone);
  }
}

// ── Batch TTS fallback ──────────────────────────────────────────────────────

async function speak(text, lang, onDone) {
  speaking = true;
  setState('speaking', 'Speaking…');
  stopCurrentAudio();
  try {
    const resp = await fetch('/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    if (resp.ok) {
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      currentAudio = audio;
      audio.onended = () => { stopCurrentAudio(); onDone(); };
      audio.onerror = () => { stopCurrentAudio(); onDone(); };
      await audio.play();
      log('Playing via ElevenLabs (batch)');
      return;
    }
    log('ElevenLabs TTS failed (HTTP ' + resp.status + '), using browser speech');
  } catch (e) {
    log('ElevenLabs TTS error, using browser speech: ' + e.message);
  }
  speakBrowser(text, lang, onDone);
}

function speakBrowser(text, lang, onDone) {
  const synth = window.speechSynthesis;
  if (!synth) { log('No SpeechSynthesis available'); onDone(); return; }
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = lang === 'zh' ? 'zh-CN' : 'en-US';
  utter.rate = 1.0;
  const voices = synth.getVoices();
  const match = voices.find(v => v.lang.startsWith(lang === 'zh' ? 'zh' : 'en'));
  if (match) { utter.voice = match; log('Browser TTS voice: ' + match.name); }
  else { log('Browser TTS: using default voice for ' + utter.lang); }
  utter.onend = () => onDone();
  utter.onerror = () => onDone();
  synth.speak(utter);
}

// ── Init ─────────────────────────────────────────────────────────────────────

async function begin() {
  if (started) return;
  overlay.style.display = 'none';
  started = true;
  log('Tap detected — requesting mic…');

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setState('error', 'Browser does not support microphone access.');
    return;
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    log('Mic access granted');
  } catch (err) {
    setState('error', 'Microphone access denied. Allow the mic and reload.');
    return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(mediaStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  if (window.speechSynthesis) {
    window.speechSynthesis.getVoices();
    window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
  }

  updateLangUI();
  startRecordingCycleStreaming();
  volumeLoop();
}

overlay.addEventListener('click', begin);
