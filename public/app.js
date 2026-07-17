// Realtime English<->Chinese voice translator
// Simplified reliable version

const overlay = document.getElementById('start');
const langEl = document.getElementById('lang');
const statusEl = document.getElementById('status');
const interimEl = document.getElementById('interim');
const transcriptEl = document.getElementById('transcript');
const pulseEl = document.querySelector('.pulse');
const logEl = document.getElementById('log');
const bodyEl = document.body;
const volFill = document.querySelector('#volmeter .fill');

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

// Audio state
let mediaStream = null;
let mediaRecorder = null;
let audioChunks = [];
let audioCtx = null;
let analyser = null;
let listening = false; // guard against duplicate calls

// STT state
let sttSessionId = null;
let sttEventSource = null;
let sttTranscript = '';
let sttReady = false;

function updateLangUI() {
  const isEn = expectLang === 'en';
  langEl.textContent = isEn ? 'Now speak: English · tap to switch' : 'Now speak: Chinese · tap to switch';
  langEl.className = isEn ? 'en' : 'zh';
}

function toggleLang() {
  expectLang = expectLang === 'en' ? 'zh' : 'en';
  updateLangUI();
  log('Language switched to: ' + expectLang);
  
  // Reset and restart with new language
  if (started && !speaking) {
    listening = false;
    stopRecording();
    closeSttSession();
    if (!paused) {
      setTimeout(startListening, 300);
    }
  }
}

langEl.addEventListener('click', toggleLang);

function togglePause() {
  if (!started) return;
  paused = !paused;
  if (paused) {
    log('Paused');
    listening = false;
    stopRecording();
    closeSttSession();
    pulseEl.style.setProperty('--vol', 0);
    setState('paused', 'Paused — click the circle to resume');
    interimEl.textContent = '';
    interimEl.classList.remove('active');
  } else {
    log('Resumed');
    setState('listening', 'Listening — speak now');
    startListening();
  }
}

pulseEl.addEventListener('click', togglePause);

// Volume animation
let volumeRAF = null;
let volSmoothed = 0;
function volumeLoop() {
  if (!started || paused) {
    volSmoothed = 0;
    pulseEl.style.setProperty('--vol', '0');
    if (volFill) volFill.style.width = '0%';
    return;
  }
  const vol = getVolume();
  const attack = 0.45;
  const release = 0.12;
  const alpha = vol > volSmoothed ? attack : release;
  volSmoothed = volSmoothed + alpha * (vol - volSmoothed);
  const boosted = Math.min(1, volSmoothed * 1.6);
  pulseEl.style.setProperty('--vol', boosted.toFixed(3));
  if (volFill) volFill.style.width = Math.min(100, boosted * 100).toFixed(1) + '%';
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

// Volume meter
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

// ── STT Session Management ──────────────────────────────────────────────────

function closeSttSession() {
  if (sttEventSource) {
    sttEventSource.close();
    sttEventSource = null;
  }
  sttSessionId = null;
  sttReady = false;
  sttTranscript = '';
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    try { mediaRecorder.stop(); } catch {}
  }
  mediaRecorder = null;
  audioChunks = [];
}

// ── Batch STT (simple and reliable) ─────────────────────────────────────────

async function transcribeAudio(blob) {
  const resp = await fetch('/stt?lang=' + expectLang, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/webm' },
    body: blob,
  });
  if (!resp.ok) throw new Error('STT failed: ' + resp.status);
  const data = await resp.json();
  return (data.transcript || '').trim();
}

// ── Main Listening Loop (Batch STT) ─────────────────────────────────────────

function startListening() {
  if (speaking || paused || listening) return;
  listening = true;
  
  audioChunks = [];
  interimEl.textContent = '';
  interimEl.classList.remove('active');

  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus' : 'audio/webm';

  try {
    mediaRecorder = new MediaRecorder(mediaStream, { mimeType });
  } catch (err) {
    log('MediaRecorder error: ' + err.message);
    setState('error', 'Cannot record audio.');
    return;
  }

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
    
    // Check total size - stop if too large (prevents 502 errors)
    const totalSize = audioChunks.reduce((sum, chunk) => sum + chunk.size, 0);
    if (totalSize > 100000 && mediaRecorder.state === 'recording') { //100KB limit
      log('Audio too large — stopping early');
      try { mediaRecorder.stop(); } catch {}
    }
  };

  mediaRecorder.onstop = async () => {
    if (paused || speaking) {
      listening = false;
      return;
    }
    
    const blob = new Blob(audioChunks, { type: 'audio/webm' });
    audioChunks = [];
    
    // Skip tiny blobs (noise)
    if (blob.size < 3000) {
      log('Audio too small — skipping');
      listening = false;
      startListening();
      return;
    }

    setState('translating', 'Transcribing…');
    log('Transcribing ' + blob.size + ' bytes…');
    
    try {
      const transcript = await transcribeAudio(blob);
      listening = false;
      if (transcript) {
        log('Transcript: "' + transcript + '"');
        handleUtterance(transcript);
      } else {
        log('Empty transcript — restarting');
        startListening();
      }
    } catch (err) {
      log('STT error: ' + err.message);
      listening = false;
      // Don't immediately retry on error - wait a bit
      setTimeout(startListening, 1000);
    }
  };

  mediaRecorder.start(200);
  setState('listening', 'Listening — speak now');
  log('Listening…');

  // Simple VAD: detect speech start, then silence to stop
  let speechStarted = false;
  let lastSpeechTime = 0;
  const SILENCE_MS = 1500;
  const MIN_SPEECH_MS = 500;
  let speechStartTime = 0;
  let volAboveThreshold = 0;

  function vadLoop() {
    if (paused || speaking || !mediaRecorder || mediaRecorder.state !== 'recording') return;
    
    const vol = getVolume();
    const now = Date.now();

    if (vol > 0.03) {
      volAboveThreshold++;
      lastSpeechTime = now;
      
      if (!speechStarted && volAboveThreshold >= 3) {
        speechStarted = true;
        speechStartTime = now;
        setState('hearing', 'Hearing you…');
        interimEl.classList.add('active');
        log('Speech detected');
      }
    } else {
      volAboveThreshold = 0;
    }

    if (speechStarted) {
      if (now - lastSpeechTime > SILENCE_MS) {
        const dur = lastSpeechTime - speechStartTime;
        if (dur < MIN_SPEECH_MS) {
          log('Speech too short — skipping');
          speechStarted = false;
          volAboveThreshold = 0;
          requestAnimationFrame(vadLoop);
          return;
        }
        log('Silence after ' + dur + 'ms — processing');
        interimEl.textContent = '';
        interimEl.classList.remove('active');
        try { mediaRecorder.stop(); } catch {}
        return;
      }
    }

    requestAnimationFrame(vadLoop);
  }

  requestAnimationFrame(vadLoop);
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
    const data = await resp.json();
    if (!resp.ok) console.error('Translate error:', resp.status, data);
    if (token !== translateToken) return;
    
    const translation = (data.translation || '').trim();
    if (!translation) {
      startListening();
      return;
    }
    
    const outLang = /[一-鿿]/.test(translation) ? 'zh' : 'en';
    addTurn('trans', outLang, translation);
    speakStreaming(translation, outLang, () => {
      speaking = false;
      startListening();
    });
  } catch (err) {
    console.error('Translation error:', err);
    addTurn('trans', expectLang === 'en' ? 'zh' : 'en', '(translation error)');
    speaking = false;
    startListening();
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

// ── Streaming TTS ───────────────────────────────────────────────────────────

async function speakStreaming(text, lang, onDone) {
  speaking = true;
  setState('speaking', 'Speaking…');
  stopCurrentAudio();

  if (!window.MediaSource || !MediaSource.isTypeSupported('audio/mpeg')) {
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
        log('Streaming TTS started');
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

// Batch TTS fallback
async function speak(text, lang, onDone) {
  speaking = true;
  setState('speaking', 'Speaking…');
  stopCurrentAudio();
  try {
    const resp = await fetch('/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
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
    log('ElevenLabs TTS failed, using browser speech');
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
  if (match) { utter.voice = match; }
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
  startListening();
  volumeLoop();
}

overlay.addEventListener('click', begin);
