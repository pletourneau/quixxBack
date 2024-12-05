const express = require("express");
const WebSocket = require("ws");

const app = express();
const server = require("http").createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Rooms and their game states
const rooms = {};

// Broadcast the updated game state to all clients in a room
function broadcastGameState(room) {
  const gameState = {
    type: "gameState",
    started: rooms[room].gameState.started,
    players: rooms[room].gameState.players.map((player) => ({
      name: player.name,
    })),
    turnOrder: rooms[room].gameState.turnOrder,
    activePlayerIndex: rooms[room].gameState.activePlayerIndex,
    diceValues: rooms[room].gameState.diceValues || null,
    boards: rooms[room].gameState.boards || {},
  };

  console.log("Broadcasting game state:", gameState);

  const state = JSON.stringify(gameState);
  rooms[room].clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(state);
    }
  });
}

wss.on("connection", (ws) => {
  console.log("A player connected");

  let currentRoom = null;
  let playerName = null;

  ws.on("message", (message) => {
    const data = JSON.parse(message);

    // Join Room
    if (data.type === "joinRoom") {
      const room = data.passcode;
      playerName = data.playerName;

      if (!rooms[room]) {
        rooms[room] = {
          gameState: {
            started: false,
            players: [],
            turnOrder: [],
            activePlayerIndex: 0,
            diceValues: null,
            boards: {}, // Initialize boards object here for all players
          },
          clients: [],
          roomCreator: playerName,
        };

        ws.send(JSON.stringify({ type: "newGame", room }));
        console.log(`Room ${room} created by ${playerName}`);
      }

      if (rooms[room].gameState.started) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: "Game has already started.",
          })
        );
        return;
      }

      if (!rooms[room].gameState.players.some((p) => p.name === playerName)) {
        rooms[room].gameState.players.push({ name: playerName });
      }

      rooms[room].clients.push(ws);
      currentRoom = room;

      console.log(`${playerName} joined room: ${room}`);
      console.log("Current players:", rooms[room].gameState.players);
      broadcastGameState(room);
    }

    // Start Game
    if (data.type === "startGame" && currentRoom) {
      const roomState = rooms[currentRoom].gameState;

      if (rooms[currentRoom].roomCreator === playerName) {
        roomState.turnOrder = roomState.players
          .map((player) => player.name)
          .sort(() => Math.random() - 0.5);

        roomState.activePlayerIndex = Math.floor(
          Math.random() * roomState.turnOrder.length
        );
        roomState.started = true;
        broadcastGameState(currentRoom);
      } else {
        ws.send(
          JSON.stringify({
            type: "error",
            message: "Only the room creator can start the game.",
          })
        );
      }
    }

    // Roll Dice
    if (data.type === "rollDice" && currentRoom) {
      const roomState = rooms[currentRoom].gameState;

      if (roomState.turnOrder[roomState.activePlayerIndex] === playerName) {
        const diceValues = {
          white1: Math.floor(Math.random() * 6) + 1,
          white2: Math.floor(Math.random() * 6) + 1,
          red: Math.floor(Math.random() * 6) + 1,
          yellow: Math.floor(Math.random() * 6) + 1,
          green: Math.floor(Math.random() * 6) + 1,
          blue: Math.floor(Math.random() * 6) + 1,
        };

        roomState.diceValues = diceValues;

        console.log(`Dice rolled by ${playerName}:`, diceValues);

        // Broadcast the updated game state
        broadcastGameState(currentRoom);
      } else {
        ws.send(
          JSON.stringify({
            type: "error",
            message: "You are not the active player. Wait for your turn.",
          })
        );
      }
    }

    // End Turn
    if (data.type === "endTurn" && currentRoom) {
      const roomState = rooms[currentRoom].gameState;

      if (roomState.turnOrder[roomState.activePlayerIndex] === playerName) {
        roomState.activePlayerIndex =
          (roomState.activePlayerIndex + 1) % roomState.turnOrder.length;
        console.log(
          `Turn ended by ${playerName}. Next active player: ${
            roomState.turnOrder[roomState.activePlayerIndex]
          }`
        );

        broadcastGameState(currentRoom);
      } else {
        ws.send(
          JSON.stringify({
            type: "error",
            message: "It's not your turn to end the turn.",
          })
        );
      }
    }

    // Mark Cell
    if (data.type === "markCell" && currentRoom) {
      const roomState = rooms[currentRoom].gameState;
      const { playerName: markPlayerName, color, number } = data;

      // Ensure boards structure exists for this player
      if (!roomState.boards[markPlayerName]) {
        roomState.boards[markPlayerName] = {
          red: Array(11).fill(false),
          yellow: Array(11).fill(false),
          green: Array(11).fill(false),
          blue: Array(11).fill(false),
        };
      }

      let index;
      if (color === "red" || color === "yellow") {
        index = number - 2;
      } else if (color === "green" || color === "blue") {
        index = 12 - number;
      }

      if (index >= 0 && index < 11) {
        roomState.boards[markPlayerName][color][index] = true;
        console.log(
          `${markPlayerName} marked ${color} cell ${number} as crossed`
        );
        broadcastGameState(currentRoom);
      } else {
        ws.send(
          JSON.stringify({
            type: "error",
            message: "Invalid cell number.",
          })
        );
      }
    }
  });

  ws.on("close", () => {
    if (currentRoom) {
      rooms[currentRoom].clients = rooms[currentRoom].clients.filter(
        (client) => client !== ws
      );
      rooms[currentRoom].gameState.players = rooms[
        currentRoom
      ].gameState.players.filter((player) => player.name !== playerName);

      if (
        rooms[currentRoom].gameState.turnOrder &&
        rooms[currentRoom].gameState.turnOrder.includes(playerName)
      ) {
        rooms[currentRoom].gameState.turnOrder = rooms[
          currentRoom
        ].gameState.turnOrder.filter((name) => name !== playerName);

        if (
          rooms[currentRoom].gameState.activePlayerIndex >=
          rooms[currentRoom].gameState.turnOrder.length
        ) {
          rooms[currentRoom].gameState.activePlayerIndex = 0;
        }
      }

      console.log(`${playerName} left room: ${currentRoom}`);
      broadcastGameState(currentRoom);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
