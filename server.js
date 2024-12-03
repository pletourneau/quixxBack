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
  };

  console.log("Broadcasting game state:", gameState);

  const state = JSON.stringify(gameState);
  rooms[room].clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(state);
    }
  });
}

// WebSocket connection handler
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

      // Ensure player is added only once
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
      console.log("Players before starting the game:", roomState.players);
      if (rooms[currentRoom].roomCreator === playerName) {
        roomState.turnOrder = roomState.players
          .map((player) => player.name)
          .sort(() => Math.random() - 0.5); // Shuffle the players for turn order
        roomState.started = true;
        roomState.activePlayerIndex = 0; // Start with the first player
        broadcastGameState(currentRoom);
        console.log(`Game started by room creator: ${playerName}`);
      } else {
        ws.send(
          JSON.stringify({
            type: "error",
            message: "Only the room creator can start the game.",
          })
        );
      }
    }

    // End Turn
    if (data.type === "endTurn" && currentRoom) {
      const roomState = rooms[currentRoom].gameState;

      if (playerName === roomState.turnOrder[roomState.activePlayerIndex]) {
        // Move to the next player
        roomState.activePlayerIndex =
          (roomState.activePlayerIndex + 1) % roomState.turnOrder.length;

        broadcastGameState(currentRoom); // Notify all clients of the updated state
        console.log(
          `Turn ended by ${playerName}. Next player: ${
            roomState.turnOrder[roomState.activePlayerIndex]
          }`
        );
      } else {
        ws.send(
          JSON.stringify({
            type: "error",
            message: "Only the active player can end the turn.",
          })
        );
      }
    }
  });

  // Handle Disconnection
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

        // Adjust the active player index if needed
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
