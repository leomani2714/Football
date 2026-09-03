const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const rooms = new Map();

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function roomCode() {
  let code;
  do code = crypto.randomBytes(3).toString('hex').toUpperCase();
  while (rooms.has(code));
  return code;
}

function publicPlayer(player) {
  return { name: player.name, avatar: player.avatar };
}

function broadcast(room, message) {
  room.players.forEach(player => send(player.socket, message));
}

const server = http.createServer((request, response) => {
  const file = request.url === '/' ? 'index.html' : request.url.slice(1);
  const filePath = path.join(__dirname, file);
  if (!filePath.startsWith(__dirname) || !fs.existsSync(filePath)) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  response.writeHead(200, { 'Content-Type': filePath.endsWith('.html') ? 'text/html' : 'application/json' });
  fs.createReadStream(filePath).pipe(response);
});

const wss = new WebSocket.Server({ server });
wss.on('connection', socket => {
  socket.on('message', raw => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return send(socket, { type: 'error', message: 'Invalid message.' }); }

    if (message.type === 'create') {
      const code = roomCode();
      const player = { socket, name: String(message.name || 'Player').slice(0, 16), avatar: message.avatar || '🙂', role: 'host' };
      rooms.set(code, { players: [player], question: null, answers: [], scores: [0, 0] });
      socket.room = code;
      send(socket, { type: 'room-created', room: code });
      return;
    }

    if (message.type === 'join') {
      const code = String(message.room || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) return send(socket, { type: 'error', message: 'Room not found.' });
      if (room.players.length >= 2) return send(socket, { type: 'error', message: 'That room is full.' });
      const player = { socket, name: String(message.name || 'Player').slice(0, 16), avatar: message.avatar || '🙂', role: 'guest' };
      room.players.push(player);
      socket.room = code;
      room.players.forEach(current => send(current.socket, {
        type: 'match-ready', room: code, role: current.role,
        opponent: publicPlayer(room.players.find(other => other !== current))
      }));
      return;
    }

    const room = rooms.get(socket.room);
    if (!room || room.players.length < 2) return;

    if (message.type === 'question' && room.players[0].socket === socket) {
      room.question = message.question;
      room.answers = [];
      broadcast(room, { type: 'question', question: room.question });
    } else if (message.type === 'answer') {
      if (room.answers.some(answer => answer.socket === socket)) return;
      room.answers.push({ socket, correct: !!message.correct, timeTaken: Number(message.timeTaken) || 0 });
      if (room.answers.length === 2) {
        const firstCorrect = room.answers.find(answer => answer.correct);
        const winner = firstCorrect || null;
        if (winner) room.scores[room.players.findIndex(player => player.socket === winner.socket)]++;
        room.answers.forEach(answer => {
          const playerIndex = room.players.findIndex(player => player.socket === answer.socket);
          const opponentIndex = playerIndex === 0 ? 1 : 0;
          send(answer.socket, {
            type: 'round-result',
            accepted: winner ? winner.socket === answer.socket : false,
            correct: answer.correct,
            first: room.answers[0].socket === answer.socket,
            ownGoals: room.scores[playerIndex],
            opponentGoals: room.scores[opponentIndex]
          });
        });
        room.answers = [];
      }
    } else if (message.type === 'restart') {
      room.question = null;
      room.answers = [];
      room.scores = [0, 0];
      send(room.players[0].socket, { type: 'match-ready', room: socket.room, role: 'host', opponent: publicPlayer(room.players[1]) });
      send(room.players[1].socket, { type: 'match-ready', room: socket.room, role: 'guest', opponent: publicPlayer(room.players[0]) });
    }
  });

  socket.on('close', () => {
    const room = rooms.get(socket.room);
    if (!room) return;
    room.players.filter(player => player.socket !== socket).forEach(player => send(player.socket, { type: 'opponent-left' }));
    rooms.delete(socket.room);
  });
});

server.listen(PORT, () => console.log(`Football Strike Pro running at http://localhost:${PORT}`));
