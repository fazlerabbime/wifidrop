const UI = (() => {
  const screens = {
    home: document.getElementById('screen-home'),
    waiting: document.getElementById('screen-waiting'),
    connecting: document.getElementById('screen-connecting'),
    ready: document.getElementById('screen-ready'),
    error: document.getElementById('screen-error'),
  };

  const status = {
    signal: 'Offline',
    signalTone: 'warn',
    peer: 'Waiting',
    peerTone: 'warn',
    channel: 'Idle',
    channelTone: 'warn',
  };

  let scannerStream = null;
  let scannerFrame = null;

  function show(name) {
    Object.values(screens).forEach((screen) => screen.classList.add('hidden'));
    screens[name].classList.remove('hidden');
    if (name !== 'home') stopScanner();
    renderStatus();
  }

  function showHome() {
    hideHomeMessage();
    show('home');
  }

  function showWaiting(code) {
    document.getElementById('room-code').textContent = code;
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('join', code);
    document.getElementById('share-url').textContent = url.href;
    renderQr(url.href);
    updateConnectionStatus({ peer: 'Waiting', peerTone: 'warn', channel: 'Idle', channelTone: 'warn' });
    show('waiting');
  }

  function showConnecting(detail = 'Negotiating WebRTC') {
    document.getElementById('connecting-detail').textContent = detail;
    show('connecting');
  }

  function showReady() {
    document.getElementById('ready-detail').textContent = 'Ready to send files';
    show('ready');
  }

  function showError(message, canRetry = false) {
    document.getElementById('error-msg').textContent = message;
    document.getElementById('btn-retry').classList.toggle('hidden', !canRetry);
    show('error');
  }

  function showHomeMessage(message, tone = 'error') {
    const el = document.getElementById('home-message');
    el.textContent = message;
    el.className = `message ${tone}`;
  }

  function hideHomeMessage() {
    const el = document.getElementById('home-message');
    el.textContent = '';
    el.classList.add('hidden');
  }

  function updateConnectionStatus(next) {
    Object.assign(status, next);
    renderStatus();
  }

  function renderStatus() {
    const targets = [
      ['status-signal', 'signal', 'signalTone'],
      ['status-peer', 'peer', 'peerTone'],
      ['status-channel', 'channel', 'channelTone'],
      ['status-signal-connecting', 'signal', 'signalTone'],
      ['status-peer-connecting', 'peer', 'peerTone'],
      ['status-channel-connecting', 'channel', 'channelTone'],
      ['status-signal-ready', 'signal', 'signalTone'],
      ['status-peer-ready', 'peer', 'peerTone'],
      ['status-channel-ready', 'channel', 'channelTone'],
    ];

    targets.forEach(([id, key, tone]) => {
      const el = document.getElementById(id);
      if (!el) return;
      const strong = el.querySelector('strong');
      if (strong) strong.textContent = status[key];
      el.classList.remove('ok', 'warn', 'bad');
      el.classList.add(status[tone] || 'warn');
    });
  }

  function renderQr(value) {
    const canvas = document.getElementById('qr-canvas');
    const ctx = canvas.getContext('2d');
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();

    const count = qr.getModuleCount();
    const size = canvas.width;
    const cell = Math.floor(size / count);
    const qrSize = cell * count;
    const offset = Math.floor((size - qrSize) / 2);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#101114';

    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        if (qr.isDark(row, col)) {
          ctx.fillRect(offset + col * cell, offset + row * cell, cell, cell);
        }
      }
    }
  }

  function createTransferItem(direction, name, size, message = '') {
    const el = document.createElement('div');
    el.className = 'log-item';
    el.innerHTML = `
      <div class="log-head">
        <div class="log-name">${escapeHtml(direction)} ${escapeHtml(name)} <span class="size">${formatSize(size)}</span></div>
        <span class="status">${direction === 'Sending' ? 'Sending' : 'Receiving'}</span>
      </div>
      <div class="progress-bar"><div class="progress-bar-fill"></div></div>
      <div class="metrics">
        <span class="pct">0%</span>
        <span class="speed">Waiting</span>
        <span class="eta">ETA --</span>
      </div>
      ${message ? `<div class="message warn">${escapeHtml(message)}</div>` : ''}
    `;
    el._transfer = {
      startedAt: performance.now(),
      lastAt: performance.now(),
      lastBytes: 0,
    };
    document.getElementById('transfer-log').prepend(el);
    return el;
  }

  function updateTransfer(item, done, total) {
    const now = performance.now();
    const state = item._transfer;
    const elapsed = Math.max((now - state.startedAt) / 1000, 0.001);
    const instantElapsed = Math.max((now - state.lastAt) / 1000, 0.001);
    const instantSpeed = (done - state.lastBytes) / instantElapsed;
    const avgSpeed = done / elapsed;
    const speed = instantSpeed > 0 ? instantSpeed : avgSpeed;
    const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
    const remaining = speed > 0 ? Math.max(total - done, 0) / speed : 0;

    item.querySelector('.progress-bar-fill').style.width = `${pct}%`;
    item.querySelector('.pct').textContent = `${pct}%`;
    item.querySelector('.speed').textContent = `${formatSize(speed)}/s`;
    item.querySelector('.eta').textContent = done >= total ? 'ETA 0s' : `ETA ${formatDuration(remaining)}`;

    state.lastAt = now;
    state.lastBytes = done;
  }

  function sendProgress(item, sent, total) {
    updateTransfer(item, sent, total);
  }

  function sendComplete(item) {
    item.querySelector('.status').textContent = 'Sent';
    item.querySelector('.status').className = 'status done';
    item.querySelector('.eta').textContent = 'Done';
  }

  function receiveStart(name, size, warning) {
    return createTransferItem('Receiving', name, size, warning);
  }

  function receiveProgress(item, received, total) {
    updateTransfer(item, received, total);
  }

  function receiveComplete(item, name, blob) {
    item.querySelector('.status').textContent = 'Done';
    item.querySelector('.status').className = 'status done';
    item.querySelector('.eta').textContent = 'Done';

    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }

  function transferFailed(item, message) {
    if (!item) {
      showError(message);
      return;
    }
    item.querySelector('.status').textContent = 'Failed';
    item.querySelector('.status').className = 'status failed';
    item.querySelector('.eta').textContent = message;
  }

  function handleSend(file) {
    const item = createTransferItem('Sending', file.name, file.size);
    sendFile(file, item);
  }

  function parseJoinCode(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) return '';

    try {
      const url = new URL(trimmed);
      return (url.searchParams.get('join') || '').trim().toUpperCase();
    } catch {
      const match = trimmed.match(/[A-Z0-9]{6}/i);
      return match ? match[0].toUpperCase() : '';
    }
  }

  async function startScanner() {
    hideHomeMessage();

    if (!window.isSecureContext) {
      showHomeMessage('Camera scanning requires HTTPS, localhost, or another secure browser context.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.jsQR) {
      showHomeMessage('This browser does not support QR camera scanning.');
      return;
    }

    const panel = document.getElementById('scanner-panel');
    const video = document.getElementById('scanner-video');
    const scannerStatus = document.getElementById('scanner-status');

    try {
      scannerStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      video.srcObject = scannerStream;
      await video.play();
      panel.classList.remove('hidden');
      scannerStatus.textContent = 'Point the camera at a WiFiDrop QR code.';
      scanFrame();
    } catch (error) {
      showHomeMessage(error.name === 'NotAllowedError'
        ? 'Camera permission was denied.'
        : 'Could not start the camera on this device.');
    }
  }

  function stopScanner() {
    if (scannerFrame) cancelAnimationFrame(scannerFrame);
    scannerFrame = null;

    if (scannerStream) {
      scannerStream.getTracks().forEach((track) => track.stop());
      scannerStream = null;
    }

    const video = document.getElementById('scanner-video');
    const panel = document.getElementById('scanner-panel');
    if (video) video.srcObject = null;
    if (panel) panel.classList.add('hidden');
  }

  function scanFrame() {
    const video = document.getElementById('scanner-video');
    const canvas = document.getElementById('scanner-canvas');
    const scannerStatus = document.getElementById('scanner-status');

    if (!scannerStream || video.readyState !== video.HAVE_ENOUGH_DATA) {
      scannerFrame = requestAnimationFrame(scanFrame);
      return;
    }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const result = jsQR(imageData.data, imageData.width, imageData.height);

    if (result?.data) {
      const code = parseJoinCode(result.data);
      if (code) {
        document.getElementById('join-code').value = code;
        stopScanner();
        joinRoom(code);
        return;
      }
      scannerStatus.textContent = 'QR found, but it is not a WiFiDrop room code.';
    }

    scannerFrame = requestAnimationFrame(scanFrame);
  }

  function resetToHome() {
    if (typeof disconnect === 'function') disconnect();
    else showHome();
  }

  function formatSize(bytes) {
    if (!Number.isFinite(bytes)) return '0 B';
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '--';
    if (seconds < 60) return `${Math.ceil(seconds)}s`;
    const minutes = Math.floor(seconds / 60);
    const rest = Math.ceil(seconds % 60);
    return `${minutes}m ${rest}s`;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function bindEvents() {
    const secureHint = document.getElementById('secure-hint');
    secureHint.textContent = window.isSecureContext ? 'Camera ready' : 'HTTPS needed for camera';

    document.getElementById('btn-create').addEventListener('click', createRoom);
    document.getElementById('btn-scan').addEventListener('click', startScanner);
    document.getElementById('btn-stop-scan').addEventListener('click', stopScanner);
    document.getElementById('btn-cancel').addEventListener('click', resetToHome);
    document.getElementById('btn-disconnect').addEventListener('click', resetToHome);
    document.getElementById('btn-reset-err').addEventListener('click', resetToHome);
    document.getElementById('btn-retry').addEventListener('click', retryLastAction);

    document.getElementById('btn-join').addEventListener('click', () => {
      const code = parseJoinCode(document.getElementById('join-code').value);
      if (!code) {
        showHomeMessage('Enter a room code or scan a WiFiDrop QR code.');
        return;
      }
      document.getElementById('join-code').value = code;
      joinRoom(code);
    });

    document.getElementById('join-code').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') document.getElementById('btn-join').click();
    });

    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');

    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        fileInput.click();
      }
    });

    dropZone.addEventListener('dragover', (event) => {
      event.preventDefault();
      dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));

    dropZone.addEventListener('drop', (event) => {
      event.preventDefault();
      dropZone.classList.remove('drag-over');
      Array.from(event.dataTransfer.files).forEach(handleSend);
    });

    fileInput.addEventListener('change', (event) => {
      Array.from(event.target.files).forEach(handleSend);
      event.target.value = '';
    });

    const autoJoin = parseJoinCode(new URLSearchParams(location.search).get('join'));
    if (autoJoin) {
      document.getElementById('join-code').value = autoJoin;
      joinRoom(autoJoin);
    }
  }

  bindEvents();
  renderStatus();

  return {
    showHome,
    showWaiting,
    showConnecting,
    showReady,
    showError,
    updateConnectionStatus,
    sendProgress,
    sendComplete,
    receiveStart,
    receiveProgress,
    receiveComplete,
    transferFailed,
  };
})();
