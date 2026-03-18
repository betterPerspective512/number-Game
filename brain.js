// brain.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// All active rooms stored here
const rooms = {};

// Generate a short, readable 6-character room ID
function generateRoomId() {
    return crypto.randomBytes(3).toString('hex').toUpperCase();
}

// Create a fresh game state for a new room
function createRoom() {
    return {
        players: [],
        turnCount: 0,
        gameState: 'waiting', // waiting, setting_secrets, playing, game_over
        currentPlayerIndex: 0,
        timerInterval: null,
        timeLeft: 15
    };
}

// Start a turn timer for a specific room
function startTurn(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    room.timeLeft = 15;
    clearInterval(room.timerInterval);

    // Broadcast initial turn state to lock/unlock inputs
    io.to(roomId).emit('turnUpdate', {
        currentPlayerId: room.players[room.currentPlayerIndex].id
    });

    // Broadcast the first tick immediately
    io.to(roomId).emit('timerUpdate', {
        timeLeft: room.timeLeft,
        currentPlayerId: room.players[room.currentPlayerIndex].id,
        currentPlayerName: room.players[room.currentPlayerIndex].name
    });

    room.timerInterval = setInterval(() => {
        if (!rooms[roomId]) {
            clearInterval(room.timerInterval);
            return;
        }

        room.timeLeft--;

        io.to(roomId).emit('timerUpdate', {
            timeLeft: room.timeLeft,
            currentPlayerId: room.players[room.currentPlayerIndex].id,
            currentPlayerName: room.players[room.currentPlayerIndex].name
        });

        if (room.timeLeft <= 0) {
            clearInterval(room.timerInterval);

            io.to(roomId).emit('guessResult', {
                text: `⏰ ${room.players[room.currentPlayerIndex].name} ran out of time! Turn skipped.`,
                color: 'red'
            });

            room.currentPlayerIndex = room.currentPlayerIndex === 0 ? 1 : 0;
            startTurn(roomId);
        }
    }, 1000);
}

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // --- Phase 0: Room Management ---

    // Player creates a new room
    socket.on('createRoom', (name) => {
        if (!name || !name.trim()) {
            socket.emit('errorMsg', 'Please enter a valid name.');
            return;
        }

        const roomId = generateRoomId();
        rooms[roomId] = createRoom();

        rooms[roomId].players.push({
            id: socket.id,
            name: name.trim(),
            secret: null,
            lastGuess: null
        });

        socket.join(roomId);
        socket.roomId = roomId; // track which room this socket belongs to

        socket.emit('roomCreated', { roomId });
        socket.emit('updateStatus', `Room ${roomId} created. Waiting for opponent...`);
        console.log(`Room ${roomId} created by ${name}`);
    });

    // Player joins an existing room by ID
    socket.on('joinRoom', ({ name, roomId }) => {
        if (!name || !name.trim()) {
            socket.emit('errorMsg', 'Please enter a valid name.');
            return;
        }

        const cleanRoomId = roomId.trim().toUpperCase();
        const room = rooms[cleanRoomId];

        if (!room) {
            socket.emit('errorMsg', `Room "${cleanRoomId}" does not exist.`);
            return;
        }

        if (room.players.length >= 2) {
            socket.emit('errorMsg', 'This room is already full!');
            return;
        }

        if (room.gameState !== 'waiting') {
            socket.emit('errorMsg', 'This game has already started.');
            return;
        }

        room.players.push({
            id: socket.id,
            name: name.trim(),
            secret: null,
            lastGuess: null
        });

        socket.join(cleanRoomId);
        socket.roomId = cleanRoomId;

        // Notify both players
        io.to(cleanRoomId).emit('updateStatus', `Both players joined! Set your secret numbers.`);

        room.gameState = 'setting_secrets';
        io.to(cleanRoomId).emit('gameStateUpdate', room.gameState);
        io.to(cleanRoomId).emit('playersInfo', {
            player1: room.players[0].name,
            player2: room.players[1].name
        });

        console.log(`${name} joined room ${cleanRoomId}`);
    });

    // --- Phase 2: Set Secret Number ---
    socket.on('setSecret', (secretNumber) => {
        const roomId = socket.roomId;
        const room = rooms[roomId];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.secret = parseInt(secretNumber);
            socket.emit('updateStatus', 'Secret set! Waiting for opponent...');
        }

        const allSecretsSet = room.players.every(p => p.secret !== null);
        if (allSecretsSet && room.players.length === 2) {
            room.gameState = 'playing';
            room.currentPlayerIndex = 0;
            io.to(roomId).emit('gameStateUpdate', room.gameState);
            io.to(roomId).emit('updateStatus', 'Game ON! Start guessing.');
            startTurn(roomId);
        }
    });

    // --- Phase 3: The Guessing Loop ---
    socket.on('makeGuess', (guessStr) => {
        const roomId = socket.roomId;
        const room = rooms[roomId];
        if (!room || room.gameState !== 'playing') return;

        if (room.players[room.currentPlayerIndex].id !== socket.id) {
            socket.emit('errorMsg', "Hold on, it's not your turn!");
            return;
        }

        const guess = parseInt(guessStr);

        // Server-side safety validation (client also validates)
        if (isNaN(guess) || guess < 1 || guess > 100) {
            socket.emit('errorMsg', 'Guess must be a number between 1 and 100.');
            return;
        }

        const playerIndex = room.currentPlayerIndex;
        const player = room.players[playerIndex];
        const opponentIndex = playerIndex === 0 ? 1 : 0;
        const opponent = room.players[opponentIndex];

        clearInterval(room.timerInterval);
        player.lastGuess = guess;
        room.turnCount++;

        if (guess === opponent.secret) {
            room.gameState = 'game_over';
            io.to(roomId).emit('guessResult', {
                text: `${player.name} guessed ${guess} -> 🏆 Correct!`,
                color: 'gold'
            });
            io.to(roomId).emit('gameOver', { winner: player.name });

        } else if (guess < opponent.secret) {
            io.to(roomId).emit('guessResult', {
                text: `${player.name} guessed ${guess} -> Opponent says Higher ⬆️`,
                color: 'blue'
            });
            room.currentPlayerIndex = opponentIndex;
            startTurn(roomId);

        } else {
            io.to(roomId).emit('guessResult', {
                text: `${player.name} guessed ${guess} -> Opponent says Lower ⬇️`,
                color: 'red'
            });
            room.currentPlayerIndex = opponentIndex;
            startTurn(roomId);
        }
    });

    // --- Phase 4: Reset Game ---
    socket.on('playAgain', () => {
        const roomId = socket.roomId;
        const room = rooms[roomId];
        if (!room || room.gameState !== 'game_over') return;

        room.turnCount = 0;
        room.gameState = 'setting_secrets';
        clearInterval(room.timerInterval);
        room.players.forEach(p => {
            p.secret = null;
            p.lastGuess = null;
        });

        io.to(roomId).emit('clearBoard');
        io.to(roomId).emit('gameStateUpdate', room.gameState);
        io.to(roomId).emit('updateStatus', 'New Round! Set your new secret numbers.');
    });

    // --- Disconnect ---
    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;

        const room = rooms[roomId];
        clearInterval(room.timerInterval);
        room.players = room.players.filter(p => p.id !== socket.id);

        if (room.players.length === 0) {
            // Clean up empty rooms
            delete rooms[roomId];
            console.log(`Room ${roomId} deleted (empty).`);
        } else {
            room.gameState = 'waiting';
            io.to(roomId).emit('clearBoard');
            io.to(roomId).emit('gameStateUpdate', 'waiting');
            io.to(roomId).emit('updateStatus', 'Opponent disconnected. Waiting for a new player...');
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
