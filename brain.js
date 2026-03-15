// brain.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// The Game Data Structure
let game = {
    players: [],
    turnCount: 0,
    gameState: 'waiting' // waiting, setting_secrets, playing, game_over
};

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Phase 1: Join Lobby
    socket.on('joinGame', (name) => {
        if (game.players.length >= 2) {
            socket.emit('errorMsg', 'Game is already full!');
            return;
        }

        game.players.push({
            id: socket.id,
            name: name,
            secret: null,
            lastGuess: null
        });

        io.emit('updateStatus', `Waiting for players... (${game.players.length}/2)`);

        if (game.players.length === 2) {
            game.gameState = 'setting_secrets';
            io.emit('gameStateUpdate', game.gameState);
            io.emit('updateStatus', 'Both players joined! Set your secret numbers.');
        }
    });

    // Phase 2: Set Secret Number
    socket.on('setSecret', (secretNumber) => {
        const player = game.players.find(p => p.id === socket.id);
        if (player) {
            player.secret = parseInt(secretNumber);
            socket.emit('updateStatus', 'Secret set! Waiting for opponent...');
        }

        const allSecretsSet = game.players.every(p => p.secret !== null);
        if (allSecretsSet && game.players.length === 2) {
            game.gameState = 'playing';
            io.emit('gameStateUpdate', game.gameState);
            io.emit('updateStatus', 'Game ON! Start guessing.');
        }
    });

    // Phase 3: The Guessing Loop
    socket.on('makeGuess', (guessStr) => {
        if (game.gameState !== 'playing') return;

        const guess = parseInt(guessStr);
        const playerIndex = game.players.findIndex(p => p.id === socket.id);
        const player = game.players[playerIndex];
        const opponent = game.players[playerIndex === 0 ? 1 : 0];

        player.lastGuess = guess;
        game.turnCount++;

        let feedback = '';
        let statusColor = ''; // blue for higher, red for lower, gold for win

        if (guess === opponent.secret) {
            feedback = 'Winner';
            statusColor = 'gold';
            game.gameState = 'game_over';
            
            io.emit('guessResult', {
                text: `${player.name} guessed ${guess} -> 🏆 Correct!`,
                color: statusColor
            });
            
            io.emit('gameOver', { winner: player.name });
        } else if (guess < opponent.secret) {
            feedback = 'Higher';
            statusColor = 'blue';
            io.emit('guessResult', {
                text: `${player.name} guessed ${guess} -> Opponent says ${feedback} ⬆️`,
                color: statusColor
            });
        } else {
            feedback = 'Lower';
            statusColor = 'red';
            io.emit('guessResult', {
                text: `${player.name} guessed ${guess} -> Opponent says ${feedback} ⬇️`,
                color: statusColor
            });
        }
    });

    // Phase 4: Reset Game
    socket.on('playAgain', () => {
        if (game.gameState === 'game_over') {
            game.turnCount = 0;
            game.gameState = 'setting_secrets';
            game.players.forEach(p => {
                p.secret = null;
                p.lastGuess = null;
            });
            io.emit('clearBoard');
            io.emit('gameStateUpdate', game.gameState);
            io.emit('updateStatus', 'New Game! Set your new secret numbers.');
        }
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        game.players = game.players.filter(p => p.id !== socket.id);
        game.gameState = 'waiting';
        io.emit('clearBoard');
        io.emit('gameStateUpdate', 'waiting');
        io.emit('updateStatus', 'Opponent disconnected. Waiting for new player...');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
