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
  const state = JSON.stringify({
    type: "gameState",
    ...rooms[room].gameState,
  });
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

  // Handle messages from clients
  ws.on("message", (message) => {
    const data = JSON.parse(message);

    if (data.type === "joinRoom") {
      const room = data.passcode;
      playerName = data.playerName;

      // Create room if it doesn't exist
      if (!rooms[room]) {
        rooms[room] = {
          gameState: {
            diceValues: {},
            players: [],
            activePlayerIndex: 0,
          },
          clients: [],
        };
        console.log(`Room ${room} created`);
      }

      // Add player to room
      rooms[room].gameState.players.push({
        name: playerName,
        scoreSheet: { red: [], yellow: [], green: [], blue: [] },
      });
      rooms[room].clients.push(ws);
      currentRoom = room;

      console.log(`${playerName} joined room: ${room}`);

      // Send the current game state to the newly joined client
      ws.send(JSON.stringify({ type: "gameState", ...rooms[room].gameState }));

      // Broadcast the updated game state to all clients in the room
      broadcastGameState(room);
    }

    if (data.type === "rollDice" && currentRoom) {
      const roomState = rooms[currentRoom].gameState;
      const activePlayer = roomState.players[roomState.activePlayerIndex].name;

      if (playerName === activePlayer) {
        roomState.diceValues = data.diceValues;
        broadcastGameState(currentRoom);
      }
    }

    if (data.type === "markNumber" && currentRoom) {
      const { color, number } = data;
      const player = rooms[currentRoom].gameState.players.find(
        (p) => p.name === playerName
      );

      if (player) {
        player.scoreSheet[color].push(number);
        broadcastGameState(currentRoom);
      }
    }

    if (data.type === "endTurn" && currentRoom) {
      const roomState = rooms[currentRoom].gameState;

      if (playerName === roomState.players[roomState.activePlayerIndex].name) {
        roomState.activePlayerIndex =
          (roomState.activePlayerIndex + 1) % roomState.players.length;
        broadcastGameState(currentRoom);
      }
    }
  });

  ws.on("close", () => {
    if (currentRoom) {
      rooms[currentRoom].clients = rooms[currentRoom].clients.filter(
        (client) => client !== ws
      );
      console.log(`${playerName} left room: ${currentRoom}`);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
