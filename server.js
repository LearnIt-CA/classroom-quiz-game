// server.js — Demo-friendly, tidied version for Render (Express + Socket.IO)
// Notes:
// - Same routes/events as your original (/, /display, /play, /api/*, sockets)
// - Adds trust proxy, healthcheck, name sanitization, movement throttle,
//   consistent bee tick timing, small logs/metrics, and a couple of guardrails.

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const QRCode = require('qrcode');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Behind Render/other proxies, ensure req.protocol is correct (https)
app.set('trust proxy', 1);

// --- Middleware & static files (unchanged behavior) ---
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // serves /teacher.html, /display.html, /student.html

// ====== Constants & Tunables ======
const TICK_MS = 50;                 // Bee update interval (was comment 100ms, actually 50ms)
const MOVE_STEP = 20;               // Player step size
const MOVE_THROTTLE_MS = 40;        // Prevent arrow-spam from flooding the server
const WORLD = { xMin: 50, xMax: 800, yMin: 50, yMax: 550 };
const ANSWER_ZONES = [
  { x: 155, y: 50,  width: 120, height: 120, answer: 'A' },
  { x: 365, y: 50,  width: 120, height: 120, answer: 'B' },
  { x: 575, y: 50,  width: 120, height: 120, answer: 'C' }
];

// ====== Game State ======
const gameState = {
  players: new Map(),           // id -> player
  currentQuestion: null,
  questionIndex: -1,
  isGameStarted: false,
  isQuestionActive: false,
  isWaitingForPlayers: false,
  displayConnected: false,
  teacherSocket: null,
  displaySocket: null,
  bee: { x: 425, y: 300, targetX: 425, targetY: 300, speed: 6 }
};

// Pixel character sprites
const pixelSprites = [
  { id: 1, color: '#FF6B6B', pattern: 'robot' },
  { id: 2, color: '#4ECDC4', pattern: 'ghost' },
  { id: 3, color: '#45B7D1', pattern: 'alien' },
  { id: 4, color: '#F9CA24', pattern: 'knight' },
  { id: 5, color: '#6C5CE7', pattern: 'wizard' },
  { id: 6, color: '#A8E6CF', pattern: 'ninja' },
  { id: 7, color: '#FFB6C1', pattern: 'cat' },
  { id: 8, color: '#98D8C8', pattern: 'bear' }
];

// Sample questions
const questions = [
  { id: 1, question: "What should the barista do?", options: ["A","B","C"], correctAnswer: "B" },
  { id: 2, question: "What should the vet do?", options: ["A","B","C"], correctAnswer: "A" },
];

// ====== Helpers ======
const now = () => Date.now();

function randRange(min, max) { return min + Math.random() * (max - min); }

function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }

function sanitizeName(raw) {
  if (!raw || typeof raw !== 'string') return 'PLAYER';
  // keep letters/numbers/spaces only; upper-case; max 8 chars (like original)
  const trimmed = raw.replace(/[^\p{L}\p{N} ]/gu, '').trim().toUpperCase().slice(0, 8);
  return trimmed || 'PLAYER';
}

function resetPlayerPosition(p) {
  p.x = 100 + Math.random() * 650;
  p.y = 450 + Math.random() * 100;
}

function checkAnswerZone(player) {
  if (!gameState.currentQuestion || player.currentAnswer) return null;
  for (const z of ANSWER_ZONES) {
    if (
      player.x >= z.x && player.x <= z.x + z.width &&
      player.y >= z.y && player.y <= z.y + z.height
    ) {
      player.currentAnswer = z.answer;
      player.answeredAt = now();
      if (z.answer === gameState.currentQuestion.correctAnswer) player.score += 100;
      return z.answer;
    }
  }
  return null;
}

function calculateResults() {
  const stats = { A: 0, B: 0, C: 0, D: 0 };
  const rankings = [];
  gameState.players.forEach(p => {
    if (p.currentAnswer) stats[p.currentAnswer]++;
    rankings.push({
      name: p.name,
      score: p.score,
      answer: p.currentAnswer,
      isCorrect: p.currentAnswer === gameState.currentQuestion?.correctAnswer
    });
  });
  rankings.sort((a, b) => b.score - a.score);
  return {
    stats,
    correctAnswer: gameState.currentQuestion?.correctAnswer,
    rankings: rankings.slice(0, 10),
    totalPlayers: gameState.players.size
  };
}

// ====== Bee Movement (every TICK_MS) ======
setInterval(() => {
  if (!gameState.isQuestionActive) return;

  // Randomly retarget sometimes
  if (Math.random() < 0.3) {
    gameState.bee.targetX = 50 + Math.random() * 750;
    gameState.bee.targetY = 200 + Math.random() * 350;
  }

  // Move towards target
  const dx = gameState.bee.targetX - gameState.bee.x;
  const dy = gameState.bee.targetY - gameState.bee.y;
  const dist = Math.hypot(dx, dy);
  if (dist > 5) {
    gameState.bee.x += (dx / dist) * gameState.bee.speed;
    gameState.bee.y += (dy / dist) * gameState.bee.speed;
  }

  // Collisions: only with players who haven't answered
  gameState.players.forEach(player => {
    if (player.currentAnswer) return;
    const d = Math.hypot(player.x - gameState.bee.x, player.y - gameState.bee.y);
    if (d < 30) {
      resetPlayerPosition(player);
      io.emit('bee-collision', { playerId: player.id, playerName: player.name, newX: player.x, newY: player.y });
    }
  });

  // Broadcast bee position (display only)
  if (gameState.displaySocket) {
    io.to(gameState.displaySocket).emit('bee-update', { x: gameState.bee.x, y: gameState.bee.y });
  }
}, TICK_MS);

// ====== Routes (same paths as original) ======
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'teacher.html'))); // teacher
app.get('/display', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'display.html')));
app.get('/play', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'student.html')));

// Healthcheck for pre-warm/Render
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true, players: gameState.players.size }));

// API: QR code points to /play (respect proxy https)
app.get('/api/qrcode', async (req, res) => {
  try {
    const url = new URL('/play', `${req.protocol}://${req.get('host')}`).toString();
    const img = await QRCode.toDataURL(url, { width: 300, margin: 2 });
    res.json({ success: true, qrcode: img, url });
  } catch (e) {
    res.status(500).json({ success: false, error: 'Failed to generate QR code' });
  }
});

app.get('/api/questions', (_req, res) => res.json(questions));

app.get('/api/game-status', (_req, res) => {
  res.json({
    playerCount: gameState.players.size,
    isGameStarted: gameState.isGameStarted,
    isWaitingForPlayers: gameState.isWaitingForPlayers,
    isQuestionActive: gameState.isQuestionActive,
    displayConnected: gameState.displayConnected,
    currentQuestion: gameState.currentQuestion
  });
});

// ====== Socket.IO ======
io.on('connection', (socket) => {
  const sid = socket.id;
  console.log('New connection:', sid, 'online:', io.of('/').sockets.size);

  // Teacher connects (kicks old one)
  socket.on('teacher-connect', () => {
    if (gameState.teacherSocket && gameState.teacherSocket !== sid) {
      const old = io.sockets.sockets.get(gameState.teacherSocket);
      if (old) old.disconnect(true);
    }
    gameState.teacherSocket = sid;
    socket.emit('teacher-state', {
      isGameStarted: gameState.isGameStarted,
      displayConnected: gameState.displayConnected,
      playerCount: gameState.players.size
    });
    socket.emit('display-status', { connected: gameState.displayConnected });
  });

  // Display connects (kicks old one)
  socket.on('display-connect', () => {
    if (gameState.displaySocket && gameState.displaySocket !== sid) {
      const old = io.sockets.sockets.get(gameState.displaySocket);
      if (old) old.disconnect(true);
    }
    gameState.displaySocket = sid;
    gameState.displayConnected = true;

    io.emit('display-status', { connected: true });
    socket.emit('game-state', {
      players: Array.from(gameState.players.values()),
      isGameStarted: gameState.isGameStarted,
      isWaitingForPlayers: gameState.isWaitingForPlayers,
      isQuestionActive: gameState.isQuestionActive,
      currentQuestion: gameState.currentQuestion,
      bee: gameState.bee
    });
  });

  // Student flow
  socket.on('student-join-request', () => {
    if (!gameState.isGameStarted) {
      socket.emit('game-not-started', { message: 'Waiting for teacher to start...' });
    } else if (gameState.isWaitingForPlayers || !gameState.isQuestionActive) {
      socket.emit('can-join', { message: 'Enter your name to join!' });
    } else {
      socket.emit('wait-for-round', { message: 'Question in progress. You can join after this round!' });
    }
  });

  socket.on('confirm-join', (data = {}) => {
    if (!gameState.isGameStarted) return socket.emit('join-failed', { message: 'Game not started yet' });
    if (gameState.isQuestionActive) return socket.emit('join-failed', { message: 'Please wait for the current question to end' });

    const sprite = pixelSprites[Math.floor(Math.random() * pixelSprites.length)];
    const player = {
      id: sid,
      name: sanitizeName(data.name),
      x: 0, y: 0, score: 0,
      currentAnswer: null,
      sprite,
      answeredAt: null,
      lastMoveAt: 0
    };
    resetPlayerPosition(player);
    gameState.players.set(sid, player);

    io.emit('player-joined', player);
    socket.emit('join-success', {
      player,
      gameState: {
        isQuestionActive: gameState.isQuestionActive,
        isWaitingForPlayers: gameState.isWaitingForPlayers,
        currentQuestion: gameState.currentQuestion
      }
    });
    console.log(`${player.name} joined with ${sprite.pattern}`);
  });

  // Player movement (throttled)
  socket.on('player-move', (direction) => {
    const p = gameState.players.get(sid);
    if (!p) return;

    const allowMovement = gameState.isWaitingForPlayers || (gameState.isQuestionActive && !p.currentAnswer);
    if (!allowMovement) return;

    const t = now();
    if (t - p.lastMoveAt < MOVE_THROTTLE_MS) return;
    p.lastMoveAt = t;

    const oldX = p.x, oldY = p.y;
    switch (direction) {
      case 'up':    p.y = clamp(p.y - MOVE_STEP, WORLD.yMin, WORLD.yMax); break;
      case 'down':  p.y = clamp(p.y + MOVE_STEP, WORLD.yMin, WORLD.yMax); break;
      case 'left':  p.x = clamp(p.x - MOVE_STEP, WORLD.xMin, WORLD.xMax); break;
      case 'right': p.x = clamp(p.x + MOVE_STEP, WORLD.xMin, WORLD.xMax); break;
      default: return;
    }

    let enteredZone = null;
    if (gameState.isQuestionActive) {
      enteredZone = checkAnswerZone(p);
    }

    io.emit('player-moved', {
      id: sid, x: p.x, y: p.y, oldX, oldY, direction,
      currentAnswer: p.currentAnswer, enteredZone
    });

    if (enteredZone && gameState.teacherSocket) {
      io.to(gameState.teacherSocket).emit('player-answered', { answer: enteredZone, playerName: p.name });
    }
  });

  // Teacher controls
  socket.on('teacher-start-game', () => {
    if (sid !== gameState.teacherSocket) return;
    if (!gameState.displayConnected) return socket.emit('error', { message: 'Please open display first!' });

    gameState.isGameStarted = true;
    gameState.isWaitingForPlayers = true;

    io.emit('game-started', { message: 'Game started! Players can now join.' });
    console.log('Game started - waiting for players');
  });

  socket.on('teacher-next-question', () => {
    if (sid !== gameState.teacherSocket) return;
    if (!gameState.displayConnected) return socket.emit('error', { message: 'Display not connected!' });
    if (!gameState.isGameStarted) return socket.emit('error', { message: 'Start the game first!' });

    gameState.questionIndex = (gameState.questionIndex + 1) % questions.length;
    gameState.currentQuestion = questions[gameState.questionIndex];
    gameState.isQuestionActive = true;
    gameState.isWaitingForPlayers = false;

    // Reset bee & players
    gameState.bee.x = 425; gameState.bee.y = 300;
    gameState.players.forEach(p => {
      p.currentAnswer = null;
      p.answeredAt = null;
      resetPlayerPosition(p);
    });

    if (gameState.displaySocket) {
      io.to(gameState.displaySocket).emit('show-question', {
        question: gameState.currentQuestion,
        players: Array.from(gameState.players.values()),
        bee: gameState.bee
      });
    }

    io.emit('question-started', { questionNumber: gameState.questionIndex + 1 });
    console.log('Question:', gameState.currentQuestion.question);
  });

  socket.on('teacher-show-results', () => {
    if (sid !== gameState.teacherSocket) return;
    if (!gameState.displayConnected) return socket.emit('error', { message: 'Display not connected!' });
    if (!gameState.isQuestionActive) return socket.emit('error', { message: 'No active question!' });

    const results = calculateResults();
    if (gameState.displaySocket) io.to(gameState.displaySocket).emit('show-results', results);
    socket.emit('show-results', results);

    gameState.isQuestionActive = false;
    gameState.isWaitingForPlayers = true;
    io.emit('results-shown', { canJoinNow: true });
  });

  socket.on('disconnect', () => {
    if (sid === gameState.teacherSocket) {
      console.log('Teacher disconnected');
      gameState.teacherSocket = null;
    } else if (sid === gameState.displaySocket) {
      console.log('Display disconnected');
      gameState.displaySocket = null;
      gameState.displayConnected = false;
      io.emit('display-status', { connected: false });
    } else {
      const p = gameState.players.get(sid);
      if (p) {
        console.log(`Player ${p.name} disconnected`);
        gameState.players.delete(sid);
        io.emit('player-left', sid);
      }
    }
  });
});

// ====== Start server (Render expects a long-lived process) ======
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('=====================================');
  console.log(`Pixel Quiz Server Started`);
  console.log(`Port: ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/healthz`);
  console.log('=====================================');
});
