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
  };

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

    if (data.type === "joinRoom") {
      const room = data.passcode;
      playerName = data.playerName;

      if (!rooms[room]) {
        rooms[room] = {
          gameState: {
            started: false,
            players: [],
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

      rooms[room].gameState.players.push({ name: playerName });
      rooms[room].clients.push(ws);
      currentRoom = room;

      console.log(`${playerName} joined room: ${room}`);
      broadcastGameState(room);
    }

    if (data.type === "startGame" && currentRoom) {
      const roomState = rooms[currentRoom].gameState;

      if (rooms[currentRoom].roomCreator === playerName) {
        roomState.players = roomState.players.sort(() => Math.random() - 0.5);
        roomState.started = true;
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
  });

  ws.on("close", () => {
    if (currentRoom) {
      rooms[currentRoom].clients = rooms[currentRoom].clients.filter(
        (client) => client !== ws
      );
      rooms[currentRoom].gameState.players = rooms[
        currentRoom
      ].gameState.players.filter((player) => player.name !== playerName);
      console.log(`${playerName} left room: ${currentRoom}`);
      broadcastGameState(currentRoom);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
