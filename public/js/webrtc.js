// WebRTC config - no STUN needed for same WiFi, but included as fallback
const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

const CHUNK_SIZE = 64 * 1024; // 64KB chunks

let ws, pc, dataChannel;
let sendQueue = [];
let isConnected = false;

// ── WebSocket ──────────────────────────────────────────────

function connectWS() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);

    switch (msg.type) {
      case 'created':
        UI.showWaiting(msg.code);
        break;

      case 'joined':
        UI.showConnecting();
        // Guest waits for host to initiate offer
        break;

      case 'guest-joined':
        // Host creates offer
        await createOffer();
        break;

      case 'offer':
        await handleOffer(msg.sdp);
        break;

      case 'answer':
        await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
        break;

      case 'ice-candidate':
        if (msg.candidate) {
          await pc.addIceCandidate(msg.candidate).catch(() => {});
        }
        break;

      case 'peer-left':
        UI.showDisconnected();
        break;

      case 'error':
        UI.showError(msg.message);
        break;
    }
  };

  ws.onerror = () => UI.showError('Connection error');
}

// ── WebRTC ─────────────────────────────────────────────────

function createPeerConnection() {
  pc = new RTCPeerConnection(RTC_CONFIG);

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      ws.send(JSON.stringify({ type: 'ice-candidate', candidate }));
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      isConnected = true;
      UI.showReady();
    } else if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      isConnected = false;
      UI.showDisconnected();
    }
  };
}

async function createOffer() {
  createPeerConnection();
  setupDataChannel(pc.createDataChannel('files', { ordered: true }));
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify({ type: 'offer', sdp: offer.sdp }));
}

async function handleOffer(sdp) {
  createPeerConnection();
  pc.ondatachannel = ({ channel }) => setupDataChannel(channel);
  await pc.setRemoteDescription({ type: 'offer', sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  ws.send(JSON.stringify({ type: 'answer', sdp: answer.sdp }));
}

// ── Data Channel ───────────────────────────────────────────

let incomingFile = null;

function setupDataChannel(channel) {
  dataChannel = channel;
  dataChannel.binaryType = 'arraybuffer';

  dataChannel.onopen = () => {
    isConnected = true;
    UI.showReady();
  };

  dataChannel.onclose = () => {
    isConnected = false;
  };

  dataChannel.onmessage = ({ data }) => {
    if (typeof data === 'string') {
      // Metadata
      const meta = JSON.parse(data);
      if (meta.type === 'file-start') {
        incomingFile = { name: meta.name, size: meta.size, mime: meta.mime, chunks: [], received: 0 };
        UI.receiveStart(meta.name, meta.size);
      } else if (meta.type === 'file-end') {
        const blob = new Blob(incomingFile.chunks, { type: incomingFile.mime });
        UI.receiveComplete(incomingFile.name, blob);
        incomingFile = null;
      }
    } else {
      // Binary chunk
      if (incomingFile) {
        incomingFile.chunks.push(data);
        incomingFile.received += data.byteLength;
        UI.receiveProgress(incomingFile.received, incomingFile.size);
      }
    }
  };
}

// ── Send File ──────────────────────────────────────────────

async function sendFile(file) {
  if (!isConnected || !dataChannel || dataChannel.readyState !== 'open') {
    UI.showError('Not connected');
    return;
  }

  // Send metadata
  dataChannel.send(JSON.stringify({
    type: 'file-start',
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream'
  }));

  // Send chunks
  let offset = 0;
  const buffer = await file.arrayBuffer();

  while (offset < buffer.byteLength) {
    // Backpressure: wait if buffer is full
    if (dataChannel.bufferedAmount > 1024 * 1024) {
      await new Promise(r => setTimeout(r, 10));
    }
    const chunk = buffer.slice(offset, offset + CHUNK_SIZE);
    dataChannel.send(chunk);
    offset += chunk.byteLength;
    UI.sendProgress(offset, file.size);
  }

  dataChannel.send(JSON.stringify({ type: 'file-end' }));
  UI.sendComplete(file.name);
}

// ── Actions ────────────────────────────────────────────────

function createRoom() {
  connectWS();
  ws.onopen = () => ws.send(JSON.stringify({ type: 'create' }));
}

function joinRoom(code) {
  connectWS();
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', code: code.toUpperCase() }));
}
