// server.js - Enhanced version with bee and waiting room movement
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const QRCode = require('qrcode');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============ Game State Management ============
const gameState = {
    players: new Map(),           // Active players
    currentQuestion: null,        // Current question
    questionIndex: -1,           // Question index
    isGameStarted: false,        // Has game started
    isQuestionActive: false,     // Is question active
    isWaitingForPlayers: false,  // Waiting for players to join
    displayConnected: false,     // Is display screen connected
    teacherSocket: null,         // Teacher socket ID
    displaySocket: null,         // Display socket ID
    answers: new Map(),          // Player answers
    bee: {                       // Bee position
        x: 425,
        y: 300,
        targetX: 425,
        targetY: 300,
        speed: 3
    }
};

// Pixel character sprites (8 different designs)
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
    {
        id: 1,
        question: "What is Mario's job?",
        options: ["A: Plumber", "B: Doctor", "C: Racer", "D: Chef"],
        correctAnswer: "A"
    },
    {
        id: 2,
        question: "What color is Pikachu?",
        options: ["A: Red", "B: Blue", "C: Yellow", "D: Green"],
        correctAnswer: "C"
    },
    {
        id: 3,
        question: "What does Pac-Man fear most?",
        options: ["A: Dots", "B: Ghosts", "C: Walls", "D: Cherries"],
        correctAnswer: "B"
    },
    {
        id: 4,
        question: "How many lives does a cat have?",
        options: ["A: 1", "B: 3", "C: 7", "D: 9"],
        correctAnswer: "D"
    },
    {
        id: 5,
        question: "What is 2 + 2?",
        options: ["A: 3", "B: 4", "C: 5", "D: 6"],
        correctAnswer: "B"
    }
];

// ============ Bee Movement Logic ============
// Update bee position every 100ms
setInterval(() => {
    if (gameState.isQuestionActive) {
        // Move bee more frequently and with larger range
        if (Math.random() < 0.3) { // 30% chance to change direction
            gameState.bee.targetX = 50 + Math.random() * 750;  // Wider range
            gameState.bee.targetY = 200 + Math.random() * 350;
        }
        
        // Move towards target faster
        const dx = gameState.bee.targetX - gameState.bee.x;
        const dy = gameState.bee.targetY - gameState.bee.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        if (distance > 5) {
            gameState.bee.x += (dx / distance) * 6;  // Speed increased from 3 to 6
            gameState.bee.y += (dy / distance) * 6;
        }
        
        // Check collision with players
        gameState.players.forEach(player => {
            if (!player.currentAnswer) {
                const playerDist = Math.sqrt(
                    Math.pow(player.x - gameState.bee.x, 2) + 
                    Math.pow(player.y - gameState.bee.y, 2)
                );
                
                if (playerDist < 30) {
                    // Reset player to random position at bottom
                    player.x = 100 + Math.random() * 650;
                    player.y = 450 + Math.random() * 100;
                    
                    // Notify about collision
                    io.emit('bee-collision', {
                        playerId: player.id,
                        playerName: player.name,
                        newX: player.x,
                        newY: player.y
                    });
                    
                    console.log(`Bee hit ${player.name}!`);
                }
            }
        });
        
        // Broadcast bee position
        if (gameState.displaySocket) {
            io.to(gameState.displaySocket).emit('bee-update', {
                x: gameState.bee.x,
                y: gameState.bee.y
            });
        }
    }
}, 50); 

// ============ Routes ============
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'teacher.html'));
});

app.get('/display', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'display.html'));
});

app.get('/play', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'student.html'));
});

// API endpoints
app.get('/api/qrcode', async (req, res) => {
    try {
        const protocol = req.protocol;
        const host = req.headers.host;
        const url = `${protocol}://${host}/play`;
        const qrCodeImage = await QRCode.toDataURL(url, {
            width: 300,
            margin: 2
        });
        res.json({ success: true, qrcode: qrCodeImage, url });
    } catch (error) {
        res.json({ success: false, error: 'Failed to generate QR code' });
    }
});

app.get('/api/questions', (req, res) => {
    res.json(questions);
});

app.get('/api/game-status', (req, res) => {
    res.json({
        playerCount: gameState.players.size,
        isGameStarted: gameState.isGameStarted,
        isWaitingForPlayers: gameState.isWaitingForPlayers,
        isQuestionActive: gameState.isQuestionActive,
        displayConnected: gameState.displayConnected,
        currentQuestion: gameState.currentQuestion
    });
});

// ============ Socket.IO Connection Handling ============
io.on('connection', (socket) => {
    console.log('New connection:', socket.id);
    
    // Teacher connection
    socket.on('teacher-connect', () => {
        if (gameState.teacherSocket && gameState.teacherSocket !== socket.id) {
            const oldSocket = io.sockets.sockets.get(gameState.teacherSocket);
            if (oldSocket) {
                oldSocket.disconnect();
            }
        }
        gameState.teacherSocket = socket.id;
        console.log('Teacher connected:', socket.id);
        
        socket.emit('teacher-state', {
            isGameStarted: gameState.isGameStarted,
            displayConnected: gameState.displayConnected,
            playerCount: gameState.players.size
        });
        
        socket.emit('display-status', { connected: gameState.displayConnected });
    });
    
    // Display connection
    socket.on('display-connect', () => {
        console.log('Display trying to connect:', socket.id);
        
        if (gameState.displaySocket && gameState.displaySocket !== socket.id) {
            const oldSocket = io.sockets.sockets.get(gameState.displaySocket);
            if (oldSocket) {
                oldSocket.disconnect();
            }
        }
        
        gameState.displaySocket = socket.id;
        gameState.displayConnected = true;
        console.log('Display connected successfully:', socket.id);
        
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
    
    // Student tries to join
    socket.on('student-join-request', () => {
        if (!gameState.isGameStarted) {
            socket.emit('game-not-started', {
                message: 'Waiting for teacher to start...'
            });
        } else if (gameState.isWaitingForPlayers || !gameState.isQuestionActive) {
            // Can join during waiting period or between questions
            socket.emit('can-join', {
                message: 'Enter your name to join!'
            });
        } else if (gameState.isQuestionActive) {
            socket.emit('wait-for-round', {
                message: 'Question in progress. You can join after this round!'
            });
        }
    });
    
    // Student confirms name and joins
    socket.on('confirm-join', (data) => {
        if (!gameState.isGameStarted) {
            socket.emit('join-failed', {
                message: 'Game not started yet'
            });
            return;
        }
        
        if (gameState.isQuestionActive) {
            socket.emit('join-failed', {
                message: 'Please wait for the current question to end'
            });
            return;
        }
        
        // Get random sprite
        const sprite = pixelSprites[Math.floor(Math.random() * pixelSprites.length)];
        
        // Create player with random position at bottom area
        const player = {
            id: socket.id,
            name: data.name.substring(0, 8).toUpperCase(),
            x: 100 + Math.random() * 650,
            y: 450 + Math.random() * 100,
            score: 0,
            currentAnswer: null,
            sprite: sprite,
            answeredAt: null
        };
        
        gameState.players.set(socket.id, player);
        
        io.emit('player-joined', player);
        
        socket.emit('join-success', {
            player: player,
            gameState: {
                isQuestionActive: gameState.isQuestionActive,
                isWaitingForPlayers: gameState.isWaitingForPlayers,
                currentQuestion: gameState.currentQuestion
            }
        });
        
        console.log(`Player ${player.name} joined with sprite ${sprite.pattern}`);
    });
    
    // Player movement - works in both waiting and question states
    socket.on('player-move', (direction) => {
        const player = gameState.players.get(socket.id);
        if (!player) return;
        
        // Allow movement if waiting OR if in question and not answered
        if (gameState.isWaitingForPlayers || (gameState.isQuestionActive && !player.currentAnswer)) {
            const stepSize = 20;
            const oldX = player.x;
            const oldY = player.y;
            
            switch(direction) {
                case 'up':    
                    player.y = Math.max(50, player.y - stepSize); 
                    break;
                case 'down':  
                    player.y = Math.min(550, player.y + stepSize); 
                    break;
                case 'left':  
                    player.x = Math.max(50, player.x - stepSize); 
                    break;
                case 'right': 
                    player.x = Math.min(800, player.x + stepSize); 
                    break;
            }
            
            // Check if entered answer zone (only during questions)
            let enteredZone = null;
            if (gameState.isQuestionActive) {
                enteredZone = checkAnswerZone(player);
            }
            
            // Broadcast movement
            io.emit('player-moved', {
                id: socket.id,
                x: player.x,
                y: player.y,
                oldX,
                oldY,
                direction,
                currentAnswer: player.currentAnswer,
                enteredZone
            });
            
            // If player answered, notify teacher
            if (enteredZone && gameState.teacherSocket) {
                io.to(gameState.teacherSocket).emit('player-answered', {
                    answer: enteredZone,
                    playerName: player.name
                });
            }
        }
    });
    
    // Teacher starts game
    socket.on('teacher-start-game', () => {
        if (socket.id !== gameState.teacherSocket) return;
        
        if (!gameState.displayConnected) {
            socket.emit('error', { message: 'Please open display first!' });
            return;
        }
        
        gameState.isGameStarted = true;
        gameState.isWaitingForPlayers = true;
        
        io.emit('game-started', {
            message: 'Game started! Players can now join.'
        });
        
        console.log('Game started - waiting for players');
    });
    
    // Teacher starts question
    socket.on('teacher-next-question', () => {
        if (socket.id !== gameState.teacherSocket) return;
        
        if (!gameState.displayConnected) {
            socket.emit('error', { message: 'Display not connected!' });
            return;
        }
        
        if (!gameState.isGameStarted) {
            socket.emit('error', { message: 'Start the game first!' });
            return;
        }
        
        gameState.questionIndex++;
        if (gameState.questionIndex >= questions.length) {
            gameState.questionIndex = 0;
        }
        
        gameState.currentQuestion = questions[gameState.questionIndex];
        gameState.isQuestionActive = true;
        gameState.isWaitingForPlayers = false;
        
        // Reset bee position
        gameState.bee.x = 425;
        gameState.bee.y = 300;
        
        // Reset all players for new question
        gameState.players.forEach(player => {
            player.currentAnswer = null;
            player.answeredAt = null;
            player.x = 100 + Math.random() * 650;
            player.y = 450 + Math.random() * 100;
        });
        
        // Send question to display
        if (gameState.displaySocket) {
            io.to(gameState.displaySocket).emit('show-question', {
                question: gameState.currentQuestion,
                players: Array.from(gameState.players.values()),
                bee: gameState.bee
            });
        }
        
        // Notify players
        io.emit('question-started', {
            questionNumber: gameState.questionIndex + 1
        });
        
        console.log('Question started:', gameState.currentQuestion.question);
    });
    
    // Teacher shows results
    socket.on('teacher-show-results', () => {
        if (socket.id !== gameState.teacherSocket) return;
        
        if (!gameState.displayConnected) {
            socket.emit('error', { message: 'Display not connected!' });
            return;
        }
        
        if (!gameState.isQuestionActive) {
            socket.emit('error', { message: 'No active question!' });
            return;
        }
        
        const results = calculateResults();
        
        // Send results to display
        if (gameState.displaySocket) {
            io.to(gameState.displaySocket).emit('show-results', results);
        }
        
        // Send results to teacher
        socket.emit('show-results', results);
        
        gameState.isQuestionActive = false;
        gameState.isWaitingForPlayers = true;
        
        // Notify all players that results are shown and they can join/move
        io.emit('results-shown', {
            canJoinNow: true
        });
    });
    
    // Disconnect handling
    socket.on('disconnect', () => {
        if (socket.id === gameState.teacherSocket) {
            console.log('Teacher disconnected');
            gameState.teacherSocket = null;
        } else if (socket.id === gameState.displaySocket) {
            console.log('Display disconnected');
            gameState.displaySocket = null;
            gameState.displayConnected = false;
            io.emit('display-status', { connected: false });
        } else {
            const player = gameState.players.get(socket.id);
            if (player) {
                console.log(`Player ${player.name} disconnected`);
                gameState.players.delete(socket.id);
                io.emit('player-left', socket.id);
            }
        }
    });
});

// Check if player entered answer zone
function checkAnswerZone(player) {
    if (!gameState.currentQuestion || player.currentAnswer) return null;
    
    const zones = [
        { x: 100, y: 50, width: 120, height: 120, answer: 'A' },
        { x: 270, y: 50, width: 120, height: 120, answer: 'B' },
        { x: 460, y: 50, width: 120, height: 120, answer: 'C' },
        { x: 630, y: 50, width: 120, height: 120, answer: 'D' }
    ];
    
    for (const zone of zones) {
        if (player.x >= zone.x && 
            player.x <= zone.x + zone.width &&
            player.y >= zone.y && 
            player.y <= zone.y + zone.height) {
            
            player.currentAnswer = zone.answer;
            player.answeredAt = Date.now();
            
            if (zone.answer === gameState.currentQuestion.correctAnswer) {
                player.score += 100;
            }
            
            console.log(`${player.name} selected ${zone.answer}`);
            
            return zone.answer;
        }
    }
    return null;
}

// Calculate results
function calculateResults() {
    const stats = { A: 0, B: 0, C: 0, D: 0 };
    const rankings = [];
    
    gameState.players.forEach(player => {
        if (player.currentAnswer) {
            stats[player.currentAnswer]++;
        }
        rankings.push({
            name: player.name,
            score: player.score,
            answer: player.currentAnswer,
            isCorrect: player.currentAnswer === gameState.currentQuestion?.correctAnswer
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('=====================================');
    console.log(`🎮 Pixel Quiz Server Started!`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`🌐 Access: http://localhost:${PORT}`);
    console.log('=====================================');
});