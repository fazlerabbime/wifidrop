const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

const CHUNK_SIZE = 256 * 1024;
const BUFFER_HIGH_WATER = 8 * 1024 * 1024;
const BUFFER_LOW_WATER = 2 * 1024 * 1024;
const LARGE_FALLBACK_WARNING = 512 * 1024 * 1024;
const SIGNAL_HEARTBEAT_MS = 15000;

let ws;
let pc;
let dataChannel;
let isConnected = false;
let signalTimer;
let lastAction = null;
let pendingCandidates = [];
let incomingFile = null;
let sendChain = Promise.resolve();

function setConnectionStatus(status) {
  if (typeof UI !== 'undefined' && UI.updateConnectionStatus) {
    UI.updateConnectionStatus(status);
  }
}

function sendSignal(message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function startSignalHeartbeat() {
  clearInterval(signalTimer);
  signalTimer = setInterval(() => sendSignal({ type: 'ping' }), SIGNAL_HEARTBEAT_MS);
}

function stopSignalHeartbeat() {
  clearInterval(signalTimer);
  signalTimer = null;
}

function connectWS(onOpen) {
  closeSignalingOnly();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);
  setConnectionStatus({ signal: 'Connecting', signalTone: 'warn' });

  ws.onopen = () => {
    setConnectionStatus({ signal: 'Online', signalTone: 'ok' });
    startSignalHeartbeat();
    onOpen();
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);

    try {
      switch (msg.type) {
        case 'pong':
          setConnectionStatus({ signal: 'Online', signalTone: 'ok' });
          break;

        case 'created':
          UI.showWaiting(msg.code);
          break;

        case 'joined':
          UI.showConnecting('Waiting for host offer');
          setConnectionStatus({ peer: 'Found', peerTone: 'ok', channel: 'Opening', channelTone: 'warn' });
          break;

        case 'guest-joined':
          UI.showConnecting('Peer joined, creating secure channel');
          setConnectionStatus({ peer: 'Found', peerTone: 'ok', channel: 'Opening', channelTone: 'warn' });
          await createOffer();
          break;

        case 'offer':
          await handleOffer(msg.sdp);
          break;

        case 'answer':
          await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
          await flushPendingCandidates();
          break;

        case 'ice-candidate':
          await addIceCandidate(msg.candidate);
          break;

        case 'peer-left':
          isConnected = false;
          if (msg.recoverable) {
            UI.showWaiting(currentRoomCode());
            setConnectionStatus({ peer: 'Left', peerTone: 'warn', channel: 'Idle', channelTone: 'warn' });
          } else {
            UI.showError('Peer disconnected and the room was closed.', true);
          }
          cleanupPeerConnection();
          break;

        case 'room-closed':
          isConnected = false;
          UI.showError('Room closed. Create a new room or join another one.', true);
          cleanupPeerConnection();
          break;

        case 'error':
          UI.showError(msg.message, true);
          break;
      }
    } catch (error) {
      UI.showError(error.message || 'Connection negotiation failed', true);
    }
  };

  ws.onerror = () => {
    setConnectionStatus({ signal: 'Error', signalTone: 'bad' });
    UI.showError('Signaling connection failed. Check that both devices can reach this WiFiDrop address.', true);
  };

  ws.onclose = () => {
    stopSignalHeartbeat();
    setConnectionStatus({ signal: 'Offline', signalTone: 'bad' });
    if (!isConnected) {
      UI.showError('Signaling disconnected before the transfer channel opened.', true);
    }
  };
}

function closeSignalingOnly() {
  stopSignalHeartbeat();
  if (ws && ws.readyState !== WebSocket.CLOSED) {
    ws.onclose = null;
    ws.close();
  }
  ws = null;
}

function cleanupPeerConnection() {
  if (dataChannel) {
    dataChannel.onopen = null;
    dataChannel.onclose = null;
    dataChannel.onmessage = null;
    dataChannel.close();
  }
  if (pc) {
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.oniceconnectionstatechange = null;
    pc.close();
  }
  dataChannel = null;
  pc = null;
  pendingCandidates = [];
}

function disconnect() {
  isConnected = false;
  cleanupPeerConnection();
  closeSignalingOnly();
  if (incomingFile && incomingFile.writer) {
    incomingFile.writer.abort().catch(() => {});
  }
  incomingFile = null;
  UI.showHome();
}

function currentRoomCode() {
  const code = document.getElementById('room-code');
  return code ? code.textContent.trim() : '';
}

function createPeerConnection() {
  cleanupPeerConnection();
  pc = new RTCPeerConnection(RTC_CONFIG);

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) sendSignal({ type: 'ice-candidate', candidate });
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    if (state === 'connected') {
      setConnectionStatus({ peer: 'Connected', peerTone: 'ok' });
    } else if (state === 'connecting') {
      setConnectionStatus({ peer: 'Connecting', peerTone: 'warn' });
    } else if (['disconnected', 'failed', 'closed'].includes(state)) {
      isConnected = false;
      setConnectionStatus({ peer: state, peerTone: 'bad' });
      if (state === 'failed') UI.showError('Peer connection failed. Retry from the same network.', true);
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'checking') {
      UI.showConnecting('Checking the local network path');
    }
  };
}

async function createOffer() {
  createPeerConnection();
  setupDataChannel(pc.createDataChannel('files', { ordered: true }));
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendSignal({ type: 'offer', sdp: offer.sdp });
}

async function handleOffer(sdp) {
  UI.showConnecting('Answering host offer');
  createPeerConnection();
  pc.ondatachannel = ({ channel }) => setupDataChannel(channel);
  await pc.setRemoteDescription({ type: 'offer', sdp });
  await flushPendingCandidates();
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sendSignal({ type: 'answer', sdp: answer.sdp });
}

async function addIceCandidate(candidate) {
  if (!candidate) return;
  if (!pc || !pc.remoteDescription) {
    pendingCandidates.push(candidate);
    return;
  }
  await pc.addIceCandidate(candidate).catch(() => {});
}

async function flushPendingCandidates() {
  const candidates = pendingCandidates.splice(0);
  await Promise.all(candidates.map((candidate) => pc.addIceCandidate(candidate).catch(() => {})));
}

function setupDataChannel(channel) {
  dataChannel = channel;
  dataChannel.binaryType = 'arraybuffer';
  dataChannel.bufferedAmountLowThreshold = BUFFER_LOW_WATER;
  setConnectionStatus({ channel: 'Opening', channelTone: 'warn' });

  dataChannel.onopen = () => {
    isConnected = true;
    setConnectionStatus({ peer: 'Connected', peerTone: 'ok', channel: 'Open', channelTone: 'ok' });
    UI.showReady();
  };

  dataChannel.onclose = () => {
    isConnected = false;
    setConnectionStatus({ channel: 'Closed', channelTone: 'bad' });
  };

  dataChannel.onerror = () => {
    setConnectionStatus({ channel: 'Error', channelTone: 'bad' });
    UI.showError('Transfer channel failed. Reconnect both devices and try again.', true);
  };

  dataChannel.onmessage = ({ data }) => {
    receiveMessage(data).catch((error) => {
      UI.showError(error.message || 'Receiving failed', true);
    });
  };
}

async function receiveMessage(data) {
  if (typeof data === 'string') {
    const meta = JSON.parse(data);

    if (meta.type === 'file-start') {
      incomingFile = await createIncomingFile(meta);
      return;
    }

    if (meta.type === 'file-end' && incomingFile) {
      await completeIncomingFile();
      return;
    }
  }

  if (!incomingFile) return;

  const chunk = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
  incomingFile.received += chunk.byteLength;

  if (incomingFile.writer) {
    await incomingFile.writer.write(new Uint8Array(chunk));
  } else {
    incomingFile.chunks.push(chunk);
  }

  UI.receiveProgress(incomingFile.item, incomingFile.received, incomingFile.size);
}

async function createIncomingFile(meta) {
  const fallbackWarning = meta.size > LARGE_FALLBACK_WARNING && !navigator.storage?.getDirectory
    ? 'This browser will keep the received file in memory until download starts.'
    : '';

  const incoming = {
    name: meta.name || 'download',
    size: meta.size || 0,
    mime: meta.mime || 'application/octet-stream',
    received: 0,
    chunks: [],
    writer: null,
    fileHandle: null,
    item: UI.receiveStart(meta.name || 'download', meta.size || 0, fallbackWarning),
  };

  if (navigator.storage?.getDirectory && window.isSecureContext) {
    try {
      const root = await navigator.storage.getDirectory();
      incoming.fileHandle = await root.getFileHandle(`wifidrop-${Date.now()}-${safeFileName(incoming.name)}`, { create: true });
      incoming.writer = await incoming.fileHandle.createWritable();
      incoming.chunks = null;
    } catch {
      incoming.writer = null;
      incoming.fileHandle = null;
      incoming.chunks = [];
    }
  }

  return incoming;
}

async function completeIncomingFile() {
  let fileLike;

  if (incomingFile.writer) {
    await incomingFile.writer.close();
    fileLike = await incomingFile.fileHandle.getFile();
  } else {
    fileLike = new Blob(incomingFile.chunks, { type: incomingFile.mime });
  }

  UI.receiveComplete(incomingFile.item, incomingFile.name, fileLike);
  incomingFile = null;
}

async function waitForBuffer() {
  if (!dataChannel || dataChannel.readyState !== 'open') {
    throw new Error('Transfer channel is not open');
  }
  if (dataChannel.bufferedAmount < BUFFER_HIGH_WATER) return;

  await new Promise((resolve) => {
    const previous = dataChannel.onbufferedamountlow;
    dataChannel.onbufferedamountlow = (event) => {
      dataChannel.onbufferedamountlow = previous;
      if (previous) previous.call(dataChannel, event);
      resolve();
    };
  });
}

async function sendFileInternal(file, item) {
  if (!isConnected || !dataChannel || dataChannel.readyState !== 'open') {
    throw new Error('Not connected');
  }

  dataChannel.send(JSON.stringify({
    type: 'file-start',
    name: file.name,
    size: file.size,
    mime: file.type || 'application/octet-stream'
  }));

  let offset = 0;

  while (offset < file.size) {
    await waitForBuffer();
    const chunk = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
    dataChannel.send(chunk);
    offset += chunk.byteLength;
    UI.sendProgress(item, offset, file.size);
  }

  await waitForBuffer();
  dataChannel.send(JSON.stringify({ type: 'file-end' }));
  UI.sendComplete(item, file.name);
}

function sendFile(file, item) {
  sendChain = sendChain
    .then(() => sendFileInternal(file, item))
    .catch((error) => {
      UI.transferFailed(item, error.message || 'Send failed');
    });
  return sendChain;
}

function safeFileName(name) {
  return String(name || 'download').replace(/[\\/:*?"<>|]/g, '_').slice(0, 160);
}

function createRoom() {
  lastAction = () => createRoom();
  connectWS(() => sendSignal({ type: 'create' }));
}

function joinRoom(code) {
  const cleanCode = String(code || '').trim().toUpperCase();
  if (!cleanCode) return;
  lastAction = () => joinRoom(cleanCode);
  connectWS(() => sendSignal({ type: 'join', code: cleanCode }));
}

function retryLastAction() {
  cleanupPeerConnection();
  closeSignalingOnly();
  if (lastAction) lastAction();
  else UI.showHome();
}
