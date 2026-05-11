const UI = (() => {
  const screens = {
    home: document.getElementById('screen-home'),
    waiting: document.getElementById('screen-waiting'),
    connecting: document.getElementById('screen-connecting'),
    ready: document.getElementById('screen-ready'),
    error: document.getElementById('screen-error'),
  };

  function show(name) {
    Object.values(screens).forEach(s => s.classList.add('hidden'));
    if (screens[name]) screens[name].classList.remove('hidden');
  }

  // ── Screens ──────────────────────────────────────────────

  function showWaiting(code) {
    document.getElementById('room-code').textContent = code;
    // QR
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(location.href + '?join=' + code)}`;
    document.getElementById('qr-img').src = qrUrl;
    show('waiting');
  }

  function showConnecting() {
    show('connecting');
  }

  function showReady() {
    show('ready');
    document.getElementById('transfer-log').innerHTML = '';
  }

  function showDisconnected() {
    showError('Peer disconnected');
  }

  function showError(msg) {
    document.getElementById('error-msg').textContent = msg;
    show('error');
  }

  // ── Transfer UI ──────────────────────────────────────────

  function log(html) {
    const el = document.getElementById('transfer-log');
    const item = document.createElement('div');
    item.className = 'log-item';
    item.innerHTML = html;
    el.prepend(item);
    return item;
  }

  let sendLogItem = null;

  function sendProgress(sent, total) {
    const pct = Math.round((sent / total) * 100);
    if (sendLogItem) {
      sendLogItem.querySelector('.progress-bar-fill').style.width = pct + '%';
      sendLogItem.querySelector('.pct').textContent = pct + '%';
    }
  }

  function sendComplete(name) {
    if (sendLogItem) {
      sendLogItem.querySelector('.status').textContent = '✓ Sent';
      sendLogItem.querySelector('.status').className = 'status done';
    }
  }

  let recvLogItem = null;

  function receiveStart(name, size) {
    recvLogItem = log(`
      <div class="log-name">↓ ${name} <span class="size">${formatSize(size)}</span></div>
      <div class="progress-bar"><div class="progress-bar-fill"></div></div>
      <span class="pct">0%</span> <span class="status">Receiving…</span>
    `);
  }

  function receiveProgress(received, total) {
    const pct = Math.round((received / total) * 100);
    if (recvLogItem) {
      recvLogItem.querySelector('.progress-bar-fill').style.width = pct + '%';
      recvLogItem.querySelector('.pct').textContent = pct + '%';
    }
  }

  function receiveComplete(name, blob) {
    if (recvLogItem) {
      recvLogItem.querySelector('.status').textContent = '✓ Done';
      recvLogItem.querySelector('.status').className = 'status done';
    }
    // Auto-download
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
  }

  // ── Helpers ──────────────────────────────────────────────

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  // ── Event Bindings ───────────────────────────────────────

  document.getElementById('btn-create').addEventListener('click', () => createRoom());

  document.getElementById('btn-join').addEventListener('click', () => {
    const code = document.getElementById('join-code').value.trim();
    if (!code) return;
    joinRoom(code);
  });

  document.getElementById('join-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-join').click();
  });

  document.getElementById('btn-reset').addEventListener('click', () => {
    if (ws) ws.close();
    if (pc) pc.close();
    show('home');
  });

  document.getElementById('btn-reset-err').addEventListener('click', () => {
    if (ws) ws.close();
    if (pc) pc.close();
    show('home');
  });

  // File drop / pick
  const dropZone = document.getElementById('drop-zone');

  dropZone.addEventListener('click', () => document.getElementById('file-input').click());

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const files = e.dataTransfer.files;
    for (const f of files) handleSend(f);
  });

  document.getElementById('file-input').addEventListener('change', (e) => {
    for (const f of e.target.files) handleSend(f);
    e.target.value = '';
  });

  function handleSend(file) {
    sendLogItem = log(`
      <div class="log-name">↑ ${file.name} <span class="size">${formatSize(file.size)}</span></div>
      <div class="progress-bar"><div class="progress-bar-fill"></div></div>
      <span class="pct">0%</span> <span class="status">Sending…</span>
    `);
    sendFile(file);
  }

  // Auto-join from URL
  const params = new URLSearchParams(location.search);
  const autoJoin = params.get('join');
  if (autoJoin) {
    document.getElementById('join-code').value = autoJoin;
    joinRoom(autoJoin);
  }

  return { showWaiting, showConnecting, showReady, showDisconnected, showError, sendProgress, sendComplete, receiveStart, receiveProgress, receiveComplete };
})();
