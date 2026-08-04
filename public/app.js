// Self-hosted realtime EN↔ZH translation via WebRTC + Qwen2.5-Omni (auto ping-pong)

const overlay = document.getElementById('start');
const transcriptEl = document.getElementById('transcript');
const statusEl = document.getElementById('status');
const pulseEl = document.querySelector('.pulse');
const bodyEl = document.body;

let pc = null, dc = null, started = false;

function log(msg) {
  const t = new Date().toLocaleTimeString();
  console.log(`[translator] ${t} ${msg}`);
}

function addTurn(text) {
  const wrap = document.createElement('div');
  wrap.className = 'turn trans';
  wrap.innerHTML = `<div class="who">Translation</div><div class="body">${text || '(…)'}</div>`;
  transcriptEl.appendChild(wrap);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function setState(s, text) {
  bodyEl.dataset.state = s;
  if (text != null) statusEl.textContent = text;
}

async function begin() {
  if (started) return;
  overlay.style.display = 'none';
  started = true;
  setState('listening', 'Connecting…');

  try {
    const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
    log('Mic access granted');

    pc = new RTCPeerConnection();
    pc.addTrack(ms.getTracks()[0], ms);

    const audio = new Audio();
    audio.autoplay = true;
    pc.ontrack = (e) => { audio.srcObject = e.streams[0]; };

    dc = pc.createDataChannel('events');
    dc.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      if (ev.type === 'text') addTurn(ev.text);
      if (ev.type === 'error') console.error('[gateway]', ev.text || ev);
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const resp = await fetch('/offer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: offer.sdp,
    });
    if (!resp.ok) {
      setState('error', 'Gateway unavailable (' + resp.status + ')');
      return;
    }

    await pc.setRemoteDescription({
      type: 'answer',
      sdp: await resp.text(),
    });

    setState('listening', 'Listening — speak now');
  } catch (err) {
    setState('error', err.message);
  }
}

overlay.addEventListener('click', begin);