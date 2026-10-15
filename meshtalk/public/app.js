// MeshTalk client
//
// Signaling server (server.js) only ever sees: who wants to join which
// room, and opaque WebRTC handshake blobs addressed "to" a peer id.
// Once a peer connection's data channel opens, every chat message you see
// below travelled directly from that browser to this one.

let ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// Ask the server for ICE config (adds a TURN relay if the host configured one)
fetch('/ice-config')
  .then((r) => (r.ok ? r.json() : null))
  .then((cfg) => { if (cfg && Array.isArray(cfg.iceServers)) ICE_SERVERS = cfg.iceServers; })
  .catch(() => {});

const $ = (id) => document.getElementById(id);

const joinScreen = $('join-screen');
const chatScreen = $('chat-screen');
const nameInput = $('name-input');
const roomInput = $('room-input');
const newRoomBtn = $('new-room-btn');
const joinBtn = $('join-btn');
const joinError = $('join-error');
const roomCodeLabel = $('room-code-label');
const myNameLabel = $('my-name-label');
const peerList = $('peer-list');
const peerCountLabel = $('peer-count');
const chatLog = $('chat-log');
const composer = $('composer');
const msgInput = $('msg-input');
const copyLinkBtn = $('copy-link-btn');
const copyLinkBtnMobile = $('copy-link-btn-mobile');
const roomCodeMobile = $('room-code-mobile');
const meshGraph = $('mesh-graph');

let ws = null;
let myId = null;
let myName = null;
let currentRoom = null;

// peerId -> { name, pc, dc, status: 'connecting'|'connected'|'left', pendingCandidates: [] }
const peers = new Map();

const WORDS = ['ember', 'rooftop', 'quartz', 'harbor', 'lantern', 'thistle', 'copper', 'meridian', 'birch', 'ferry', 'granite', 'signal'];
function randomRoomCode() {
  const a = WORDS[Math.floor(Math.random() * WORDS.length)];
  const n = Math.floor(Math.random() * 90 + 10);
  return `${a}-${n}`;
}

// Prefill room from invite link (?room=xyz)
const params = new URLSearchParams(location.search);
if (params.get('room')) roomInput.value = params.get('room');
newRoomBtn.addEventListener('click', () => { roomInput.value = randomRoomCode(); });

function hueFromName(name) {
  name = String(name || '');
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

function initials(name) {
  return escapeHtml(String(name || '?').trim().slice(0, 2).toUpperCase());
}

// ---------- Join flow ----------

function submitJoin() {
  const name = nameInput.value.trim();
  const room = roomInput.value.trim() || randomRoomCode();
  if (!name) {
    joinError.textContent = 'Pick a name first.';
    return;
  }
  joinError.textContent = '';
  joinBtn.disabled = true;
  joinBtn.textContent = 'Connecting…';
  connect(room, name);
}
joinBtn.addEventListener('click', submitJoin);
[nameInput, roomInput].forEach((el) =>
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitJoin(); })
);

function resetJoinButton() {
  joinBtn.disabled = false;
  joinBtn.textContent = 'Join mesh';
}

function connect(room, name) {
  currentRoom = room;
  myName = name;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'join', room, name }));
  });

  ws.addEventListener('message', (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    handleServerMessage(msg);
  });

  ws.addEventListener('close', () => {
    if (!myId) { resetJoinButton(); return; } // never made it into the chat
    appendSystemMessage('Disconnected from signaling server. Existing peer connections keep working; refresh to reconnect and discover new peers.');
  });

  ws.addEventListener('error', () => {
    joinError.textContent = "Couldn't reach the signaling server. Is server.js running?";
    resetJoinButton();
  });
}

function handleServerMessage(msg) {
  if (msg.type === 'error') {
    joinError.textContent = msg.message || 'Something went wrong.';
    resetJoinButton();
    return;
  }

  if (msg.type === 'welcome') {
    myId = msg.peerId;
    if (msg.room) currentRoom = msg.room;
    enterChatScreen();
    msg.peers.forEach((p) => {
      addPeerRow(p.id, p.name, 'connecting');
      createPeerConnection(p.id, p.name, true);
    });
    updatePeerCount();
    renderMeshGraph();
    return;
  }

  if (msg.type === 'peer-joined') {
    if (peers.has(msg.id)) return;
    addPeerRow(msg.id, msg.name, 'connecting');
    peers.set(msg.id, { name: msg.name, pc: null, dc: null, status: 'connecting', pendingCandidates: [] });
    updatePeerCount();
    appendSystemMessage(`${msg.name} joined the room`);
    renderMeshGraph();
    return;
  }

  if (msg.type === 'peer-left') {
    const peer = peers.get(msg.id);
    if (peer) {
      if (peer.pc) peer.pc.close();
      appendSystemMessage(`${peer.name} left`);
      peers.delete(msg.id);
    }
    removePeerRow(msg.id);
    renderMeshGraph();
    return;
  }

  if (msg.type === 'signal') {
    handleSignal(msg.from, msg.data);
  }
}

function sendSignal(to, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'signal', to, data }));
}

// ---------- WebRTC mesh ----------

function createPeerConnection(peerId, name, isInitiator) {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const entry = peers.get(peerId) || { name, pendingCandidates: [] };
  entry.pc = pc;
  entry.name = name;
  entry.status = 'connecting';
  peers.set(peerId, entry);

  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal(peerId, { kind: 'candidate', candidate: e.candidate });
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      entry.status = 'connected';
      updatePeerStatus(peerId, 'connected');
      renderMeshGraph();
    } else if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      entry.status = 'connecting';
      updatePeerStatus(peerId, 'connecting');
      renderMeshGraph();
    }
  };

  if (isInitiator) {
    const dc = pc.createDataChannel('chat');
    wireDataChannel(peerId, dc);
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => sendSignal(peerId, { kind: 'offer', sdp: pc.localDescription }));
  } else {
    pc.ondatachannel = (e) => wireDataChannel(peerId, e.channel);
  }

  return pc;
}

function wireDataChannel(peerId, dc) {
  const entry = peers.get(peerId);
  entry.dc = dc;
  dc.onopen = () => {
    entry.status = 'connected';
    updatePeerStatus(peerId, 'connected');
    renderMeshGraph();
  };
  dc.onmessage = (e) => {
    let payload;
    try { payload = JSON.parse(e.data); } catch { return; }
    if (!payload || typeof payload.text !== 'string') return;
    // Use the name the server gave us for this peer, not one the peer claims
    // in the message, so people can't impersonate each other.
    const ts = Number.isFinite(payload.ts) ? payload.ts : Date.now();
    appendMessage({ name: entry.name, text: payload.text.slice(0, 2000), ts, self: false });
  };
}

async function handleSignal(fromId, data) {
  try {
    await processSignal(fromId, data);
  } catch (err) {
    console.warn('Signal handling failed:', err);
  }
}

async function processSignal(fromId, data) {
  if (!data || typeof data !== 'object') return;
  let entry = peers.get(fromId);
  if (!entry) return; // shouldn't happen, but guard anyway

  let pc = entry.pc;
  if (!pc && data.kind === 'offer') {
    pc = createPeerConnection(fromId, entry.name, false);
  }
  if (!pc) return;

  if (data.kind === 'offer') {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    for (const c of entry.pendingCandidates) await pc.addIceCandidate(c);
    entry.pendingCandidates = [];
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendSignal(fromId, { kind: 'answer', sdp: pc.localDescription });
  } else if (data.kind === 'answer') {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    for (const c of entry.pendingCandidates) await pc.addIceCandidate(c);
    entry.pendingCandidates = [];
  } else if (data.kind === 'candidate') {
    const candidate = new RTCIceCandidate(data.candidate);
    if (pc.remoteDescription) {
      await pc.addIceCandidate(candidate);
    } else {
      entry.pendingCandidates.push(candidate);
    }
  }
}

// ---------- Sending messages ----------

composer.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = msgInput.value.trim();
  if (!text) return;
  const ts = Date.now();
  appendMessage({ name: myName, text, ts, self: true });
  const payload = JSON.stringify({ type: 'chat', from: myId, name: myName, text, ts });
  for (const [, peer] of peers) {
    if (peer.dc && peer.dc.readyState === 'open') peer.dc.send(payload);
  }
  msgInput.value = '';
});

// ---------- UI ----------

function enterChatScreen() {
  joinScreen.classList.add('hidden');
  chatScreen.classList.remove('hidden');
  roomCodeLabel.textContent = currentRoom;
  roomCodeMobile.textContent = currentRoom;
  myNameLabel.textContent = myName;
  appendSystemMessage(`You joined "${currentRoom}"`);
}

function addPeerRow(id, name, status) {
  if ($(`peer-row-${id}`)) return;
  const li = document.createElement('li');
  li.className = 'peer-item';
  li.id = `peer-row-${id}`;
  li.innerHTML = `<span class="peer-status-dot ${status === 'connected' ? 'connected' : ''}"></span><span>${escapeHtml(name)}</span>`;
  peerList.appendChild(li);
  updatePeerCount();
}

function updatePeerStatus(id, status) {
  const row = $(`peer-row-${id}`);
  if (!row) return;
  const dot = row.querySelector('.peer-status-dot');
  dot.classList.toggle('connected', status === 'connected');
}

function removePeerRow(id) {
  const row = $(`peer-row-${id}`);
  if (row) row.remove();
  updatePeerCount();
}

function updatePeerCount() {
  peerCountLabel.textContent = `(${peers.size + 1})`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function appendSystemMessage(text) {
  const row = document.createElement('div');
  row.className = 'msg-row system';
  row.textContent = text;
  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function appendMessage({ name, text, ts, self }) {
  const row = document.createElement('div');
  row.className = 'msg-row';
  const hue = hueFromName(name);
  const time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  row.innerHTML = `
    <div class="msg-avatar" style="background:hsl(${hue},55%,55%)">${initials(name)}</div>
    <div class="msg-body">
      <div class="msg-meta">
        <span class="msg-name" style="color:hsl(${hue},70%,68%)">${escapeHtml(self ? 'You' : name)}</span>
        <span class="msg-time">${time}</span>
      </div>
      <div class="msg-text">${escapeHtml(text)}</div>
    </div>`;
  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function copyInviteLink(btn) {
  const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(currentRoom)}`;
  const original = btn.textContent;
  const done = (ok) => {
    btn.textContent = ok ? 'Copied!' : 'Copy failed';
    setTimeout(() => (btn.textContent = original), 1400);
  };
  // navigator.clipboard only exists on https:// or localhost, so fall back.
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(url).then(() => done(true), () => done(false));
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = url;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  document.body.removeChild(ta);
  done(ok);
}
copyLinkBtn.addEventListener('click', () => copyInviteLink(copyLinkBtn));
copyLinkBtnMobile.addEventListener('click', () => copyInviteLink(copyLinkBtnMobile));

// ---------- Mesh graph visualization ----------
// A live node graph is the whole point of this app: it shows the actual
// direct connections carrying your messages, not a decorative chat-list.

function renderMeshGraph() {
  const ids = [...peers.keys()];
  const cx = 120, cy = 100, r = 68;
  const nodes = [{ id: 'me', x: cx, y: cy, label: 'You', me: true }];

  ids.forEach((id, i) => {
    const angle = (2 * Math.PI * i) / Math.max(ids.length, 1) - Math.PI / 2;
    nodes.push({
      id,
      x: cx + r * Math.cos(angle),
      y: cy + r * Math.sin(angle),
      label: peers.get(id).name,
      status: peers.get(id).status,
    });
  });

  let svg = '';
  // links first (under nodes)
  nodes.slice(1).forEach((n) => {
    const connected = n.status === 'connected';
    svg += `<line x1="${cx}" y1="${cy}" x2="${n.x}" y2="${n.y}"
      stroke="${connected ? 'var(--signal)' : 'var(--amber)'}"
      stroke-width="1.6" stroke-dasharray="${connected ? '0' : '3,3'}" opacity="${connected ? '0.9' : '0.55'}"/>`;
  });
  // nodes
  nodes.forEach((n) => {
    const fill = n.me ? 'var(--signal)' : (n.status === 'connected' ? 'var(--signal)' : 'var(--amber)');
    svg += `<circle cx="${n.x}" cy="${n.y}" r="${n.me ? 9 : 7}" fill="${fill}" />`;
    svg += `<text x="${n.x}" y="${n.y + (n.me ? 22 : 20)}" text-anchor="middle"
      font-family="IBM Plex Mono, monospace" font-size="9" fill="var(--text-dim)">${escapeXml(String(n.label || '').slice(0, 10))}</text>`;
  });

  meshGraph.innerHTML = svg;
}

function escapeXml(str) {
  return str.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

renderMeshGraph();
