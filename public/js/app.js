// ── Конфигурация WebRTC ─────────────────────────────────────────
const ICE_SERVERS = {
  iceServers: [
    {
      urls: 'stun:stun.relay.metered.ca:80',
    },
    {
      urls: 'turn:global.relay.metered.ca:80',
      username: '0bb4bdbd11251b8823e9d91e',
      credential: '+3L+LTQco3b+FlTl',
    },
    {
      urls: 'turn:global.relay.metered.ca:80?transport=tcp',
      username: '0bb4bdbd11251b8823e9d91e',
      credential: '+3L+LTQco3b+FlTl',
    },
    {
      urls: 'turn:global.relay.metered.ca:443',
      username: '0bb4bdbd11251b8823e9d91e',
      credential: '+3L+LTQco3b+FlTl',
    },
    {
      urls: 'turns:global.relay.metered.ca:443?transport=tcp',
      username: '0bb4bdbd11251b8823e9d91e',
      credential: '+3L+LTQco3b+FlTl',
    },
  ]
};

// ── Состояние приложения ────────────────────────────────────────
const state = {
  socket: null,
  roomId: null,
  userName: null,
  localStream: null,
  peers: {},       // { socketId: RTCPeerConnection }
  muted: false
};

const audioAnalysers = {}; // { peerId: AnalyserNode }

function startVoiceDetection(peerId, stream) {
  const audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.3;
  source.connect(analyser);
  audioAnalysers[peerId] = analyser;

  const data = new Uint8Array(analyser.frequencyBinCount);
  const THRESHOLD = 20; // Порог громкости (0-255)

  function detect() {
    analyser.getByteFrequencyData(data);
    const volume = data.reduce((a, b) => a + b, 0) / data.length;
    const avatar = document.getElementById(`avatar-${peerId}`);
    if (avatar) {
      if (volume > THRESHOLD) {
        avatar.classList.add('speaking');
      } else {
        avatar.classList.remove('speaking');
      }
    }
    requestAnimationFrame(detect);
  }
  detect();
}

// ── DOM-элементы ────────────────────────────────────────────────
const screens = {
  lobby: document.getElementById('lobby-screen'),
  room: document.getElementById('room-screen')
};

const ui = {
  roomIdInput: document.getElementById('room-id-input'),
  userNameInput: document.getElementById('user-name-input'),
  joinBtn: document.getElementById('join-btn'),
  leaveBtn: document.getElementById('leave-btn'),
  muteBtn: document.getElementById('mute-btn'),
  muteIcon: document.getElementById('mute-icon'),
  muteLabel: document.getElementById('mute-label'),
  roomLabel: document.getElementById('room-label'),
  participantsList: document.getElementById('participants-list'),
  notification: document.getElementById('notification'),
  generateBtn: document.getElementById('generate-room-btn'),
  copyBtn: document.getElementById('copy-room-btn')
};

// ── Инициализация Socket.io ──────────────────────────────────────
function initSocket() {
  state.socket = io();
  const s = state.socket;

  s.on('room-users', (users) => {
    // Нас уже добавили — создаём оффер для каждого в комнате
    users.forEach(user => {
      addParticipant(user.id, user.name, user.muted);
      createOffer(user.id);
    });
  });

  s.on('user-joined', (user) => {
    showNotification(`${user.name} вошёл в комнату`);
    addParticipant(user.id, user.name, false);
    // Новый пользователь сам инициирует — нам ждать
  });

  s.on('user-left', ({ userId, name }) => {
    showNotification(`${name || 'Участник'} покинул комнату`);
    removePeer(userId);
    removeParticipant(userId);
  });

  s.on('offer', async ({ fromId, offer }) => {
    await handleOffer(fromId, offer);
  });

  s.on('answer', async ({ fromId, answer }) => {
    const pc = state.peers[fromId];
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
  });

  s.on('ice-candidate', async ({ fromId, candidate }) => {
    const pc = state.peers[fromId];
    if (pc && candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
    }
  });

  s.on('user-muted', ({ userId, muted }) => {
    updateParticipantMute(userId, muted);
  });
}

// ── WebRTC ───────────────────────────────────────────────────────

function createPeerConnection(peerId) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  state.peers[peerId] = pc;

  // Добавляем локальные треки
  state.localStream.getTracks().forEach(track => {
    pc.addTrack(track, state.localStream);
  });

  // ICE кандидаты → сервер
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      state.socket.emit('ice-candidate', { targetId: peerId, candidate });
    }
  };

  // Удалённый поток → <audio>
  pc.ontrack = ({ streams }) => {
    setRemoteAudio(peerId, streams[0]);
  };

  pc.onconnectionstatechange = () => {
    console.log(`Peer ${peerId}: ${pc.connectionState}`);
  };

  return pc;
}

async function createOffer(peerId) {
  const pc = createPeerConnection(peerId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  state.socket.emit('offer', { targetId: peerId, offer });
}

async function handleOffer(fromId, offer) {
  const pc = createPeerConnection(fromId);
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  state.socket.emit('answer', { targetId: fromId, answer });
}

function removePeer(peerId) {
  if (state.peers[peerId]) {
    state.peers[peerId].close();
    delete state.peers[peerId];
  }
  const audio = document.getElementById(`audio-${peerId}`);
  if (audio) audio.remove();
}

function setRemoteAudio(peerId, stream) {
  let audio = document.getElementById(`audio-${peerId}`);
  if (!audio) {
    audio = document.createElement('audio');
    audio.id = `audio-${peerId}`;
    audio.autoplay = true;
    document.body.appendChild(audio);
  }
  audio.srcObject = stream;
  startVoiceDetection(peerId, stream);
}

// ── Участники UI ─────────────────────────────────────────────────

function addParticipant(id, name, muted) {
  if (document.getElementById(`participant-${id}`)) return;

  const initials = name.slice(0, 2).toUpperCase();
  const div = document.createElement('div');
  div.className = 'participant';
  div.id = `participant-${id}`;
  div.innerHTML = `
    <div class="participant-avatar" id="avatar-${id}">
      <span>${initials}</span>
      <div class="sound-wave" id="wave-${id}">
        <span></span><span></span><span></span>
      </div>
    </div>
    <div class="participant-name">${name}</div>
    <div class="participant-status" id="status-${id}">
      ${muted ? '<svg viewBox="0 0 24 24"><path d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4M9.071 4.071A5 5 0 0112 3a5 5 0 015 5v3M3 3l18 18"/></svg>' : ''}
    </div>
  `;
  ui.participantsList.appendChild(div);
  updateParticipantCount();
}

function removeParticipant(id) {
  const el = document.getElementById(`participant-${id}`);
  if (el) el.remove();
  updateParticipantCount();
}

function updateParticipantMute(id, muted) {
  const status = document.getElementById(`status-${id}`);
  if (!status) return;
  status.innerHTML = muted
    ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6"/>
        <path d="M17 16.95A7 7 0 015 12v-2m14 0v2a7 7 0 01-.11 1.23M12 19v4M8 23h8"/>
      </svg>`
    : '';
}

function updateParticipantCount() {
  const count = ui.participantsList.children.length;
  document.getElementById('participant-count').textContent =
    `${count} участник${count === 1 ? '' : count < 5 ? 'а' : 'ов'}`;
}

// ── Основные действия ─────────────────────────────────────────────

async function joinRoom() {
  const roomId = ui.roomIdInput.value.trim();
  const userName = ui.userNameInput.value.trim();

  if (!roomId || !userName) {
    showNotification('Введите имя и ID комнаты', true);
    return;
  }

  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    startVoiceDetection('self', state.localStream);
  } catch (e) {
    showNotification('Нет доступа к микрофону', true);
    return;
  }

  state.roomId = roomId;
  state.userName = userName;

  initSocket();
  state.socket.emit('join-room', { roomId, userName });

  // Добавляем себя в список
  addParticipant('self', `${userName} (вы)`, false);

  // Переключаем экран
  ui.roomLabel.textContent = `Комната: ${roomId}`;
  screens.lobby.classList.add('hidden');
  screens.room.classList.remove('hidden');
}

function leaveRoom() {
  // Закрываем все соединения
  Object.keys(state.peers).forEach(removePeer);

  if (state.localStream) {
    state.localStream.getTracks().forEach(t => t.stop());
    state.localStream = null;
  }

  if (state.socket) {
    state.socket.disconnect();
    state.socket = null;
  }

  // Чистим UI
  ui.participantsList.innerHTML = '';
  screens.room.classList.add('hidden');
  screens.lobby.classList.remove('hidden');

  state.muted = false;
  updateMuteButton();
}

function toggleMute() {
  state.muted = !state.muted;
  if (state.localStream) {
    state.localStream.getAudioTracks().forEach(t => { t.enabled = !state.muted; });
  }
  if (state.socket) {
    state.socket.emit('toggle-mute', { muted: state.muted });
  }
  updateParticipantMute('self', state.muted);
  updateMuteButton();
}

function updateMuteButton() {
  if (state.muted) {
    ui.muteBtn.classList.add('muted');
    ui.muteLabel.textContent = 'Включить микрофон';
    ui.muteIcon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="1" y1="1" x2="23" y2="23"/>
      <path d="M9 9v3a3 3 0 005.12 2.12M15 9.34V4a3 3 0 00-5.94-.6"/>
      <path d="M17 16.95A7 7 0 015 12v-2m14 0v2a7 7 0 01-.11 1.23M12 19v4M8 23h8"/>
    </svg>`;
  } else {
    ui.muteBtn.classList.remove('muted');
    ui.muteLabel.textContent = 'Выключить микрофон';
    ui.muteIcon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/>
      <path d="M19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8"/>
    </svg>`;
  }
}

// ── Уведомления ───────────────────────────────────────────────────

function showNotification(text, isError = false) {
  ui.notification.textContent = text;
  ui.notification.className = `notification show${isError ? ' error' : ''}`;
  setTimeout(() => { ui.notification.className = 'notification'; }, 3000);
}

// ── Генерация ID комнаты ──────────────────────────────────────────

function generateRoomId() {
  const id = Math.random().toString(36).substring(2, 8).toUpperCase();
  ui.roomIdInput.value = id;
}

function copyRoomId() {
  const val = ui.roomIdInput.value.trim();
  if (!val) return;
  navigator.clipboard.writeText(val).then(() => showNotification('ID скопирован!'));
}

// ── Обработчики событий ───────────────────────────────────────────

ui.joinBtn.addEventListener('click', joinRoom);
ui.leaveBtn.addEventListener('click', leaveRoom);
ui.muteBtn.addEventListener('click', toggleMute);
ui.generateBtn.addEventListener('click', generateRoomId);
ui.copyBtn.addEventListener('click', copyRoomId);

ui.userNameInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
ui.roomIdInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });

// Генерируем ID по умолчанию
generateRoomId();
