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
    gameState: 'waiting', // waiting, setting_secrets, playing, game_over
    currentPlayerIndex: 0,
    timerInterval: null,
    timeLeft: 15
};

// Function to handle turn switching and timer management
function startTurn() {
    game.timeLeft = 15;
    clearInterval(game.timerInterval);
    
    // Broadcast initial turn state to lock/unlock inputs
    io.emit('turnUpdate', {
        currentPlayerId: game.players[game.currentPlayerIndex].id
    });

    // Broadcast the first tick immediately
    io.emit('timerUpdate', {
        timeLeft: game.timeLeft,
        currentPlayerId: game.players[game.currentPlayerIndex].id,
        currentPlayerName: game.players[game.currentPlayerIndex].name
    });

    game.timerInterval = setInterval(() => {
        game.timeLeft--;
        
        // Send absolute truth to all clients every second
        io.emit('timerUpdate', {
            timeLeft: game.timeLeft,
            currentPlayerId: game.players[game.currentPlayerIndex].id,
            currentPlayerName: game.players[game.currentPlayerIndex].name
        });
        
        // If time runs out
        if (game.timeLeft <= 0) {
            clearInterval(game.timerInterval);
            
            io.emit('guessResult', {
                text: `⏰ ${game.players[game.currentPlayerIndex].name} ran out of time! Turn skipped.`,
                color: 'red'
            });
            
            // Switch turn to the other player
            game.currentPlayerIndex = game.currentPlayerIndex === 0 ? 1 : 0;
            startTurn();
        }
    }, 1000);
}

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
            game.currentPlayerIndex = 0; // Player 1 starts
            io.emit('gameStateUpdate', game.gameState);
            io.emit('updateStatus', 'Game ON! Start guessing.');
            startTurn();
        }
    });

    // Phase 3: The Guessing Loop
    socket.on('makeGuess', (guessStr) => {
        if (game.gameState !== 'playing') return;

        if (game.players[game.currentPlayerIndex].id !== socket.id) {
            socket.emit('errorMsg', "Hold on, it's not your turn!");
            return;
        }

        const guess = parseInt(guessStr);
        const playerIndex = game.currentPlayerIndex;
        const player = game.players[playerIndex];
        const opponentIndex = playerIndex === 0 ? 1 : 0;
        const opponent = game.players[opponentIndex];

        clearInterval(game.timerInterval);

        player.lastGuess = guess;
        game.turnCount++;

        let feedback = '';
        let statusColor = ''; 

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
            
            game.currentPlayerIndex = opponentIndex;
            startTurn();
        } else {
            feedback = 'Lower';
            statusColor = 'red';
            io.emit('guessResult', {
                text: `${player.name} guessed ${guess} -> Opponent says ${feedback} ⬇️`,
                color: statusColor
            });
            
            game.currentPlayerIndex = opponentIndex;
            startTurn();
        }
    });

    // Phase 4: Reset Game
    socket.on('playAgain', () => {
        if (game.gameState === 'game_over') {
            game.turnCount = 0;
            game.gameState = 'setting_secrets';
            clearInterval(game.timerInterval);
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
        clearInterval(game.timerInterval);
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
