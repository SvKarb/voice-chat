const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});


app.use(express.static(path.join(__dirname, '../public')));

const rooms = {};

function getRoomUsers(roomId) {
  return rooms[roomId] ? Object.values(rooms[roomId]) : [];
}

io.on('connection', (socket) => {
  console.log(`[+] Подключился: ${socket.id}`);

  socket.on('join-room', ({ roomId, userName }) => {
    socket.join(roomId);

    if (!rooms[roomId]) rooms[roomId] = {};
    rooms[roomId][socket.id] = { id: socket.id, name: userName, muted: false };

    console.log(`[Room ${roomId}] ${userName} вошёл`);

    const existingUsers = getRoomUsers(roomId).filter(u => u.id !== socket.id);
    socket.emit('room-users', existingUsers);

    socket.to(roomId).emit('user-joined', rooms[roomId][socket.id]);

    socket.data.roomId = roomId;
    socket.data.userName = userName;
  });

  // Оффер (инициатор → принимающий)
  socket.on('offer', ({ targetId, offer }) => {
    io.to(targetId).emit('offer', { fromId: socket.id, offer });
  });

  // Ответ (принимающий → инициатор)
  socket.on('answer', ({ targetId, answer }) => {
    io.to(targetId).emit('answer', { fromId: socket.id, answer });
  });

  // ICE кандидаты
  socket.on('ice-candidate', ({ targetId, candidate }) => {
    io.to(targetId).emit('ice-candidate', { fromId: socket.id, candidate });
  });

  socket.on('toggle-mute', ({ muted }) => {
    const { roomId } = socket.data;
    if (roomId && rooms[roomId] && rooms[roomId][socket.id]) {
      rooms[roomId][socket.id].muted = muted;
      socket.to(roomId).emit('user-muted', { userId: socket.id, muted });
    }
  });

  socket.on('disconnect', () => {
    const { roomId, userName } = socket.data;
    if (roomId && rooms[roomId]) {
      delete rooms[roomId][socket.id];
      if (Object.keys(rooms[roomId]).length === 0) {
        delete rooms[roomId];
        console.log(`[Room ${roomId}] комната удалена`);
      }
    }
    io.to(roomId).emit('user-left', { userId: socket.id, name: userName });
    console.log(`[-] Отключился: ${userName || socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎙  Голосовой чат запущен: http://localhost:${PORT}\n`);
});
