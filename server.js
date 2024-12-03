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
      markedSpaces: player.markedSpaces, // Include marked spaces
    })),
    diceValues: rooms[room].gameState.diceValues,
    activePlayerIndex: rooms[room].gameState.activePlayerIndex,
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
        // Create a new room
        rooms[room] = {
          gameState: {
            started: false,
            diceValues: {},
            players: [],
            activePlayerIndex: 0,
          },
          clients: [],
          roomCreator: playerName, // Track the creator of the room
        };

        // Notify the first player (creator) they are the room owner
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

      // Add the player to the room
      rooms[room].gameState.players.push({
        name: playerName,
        markedSpaces: [],
        scoreSheet: { red: [], yellow: [], green: [], blue: [] },
      });
      rooms[room].clients.push(ws);
      currentRoom = room;

      console.log(`${playerName} joined room: ${room}`);
      broadcastGameState(room);
    }

    if (data.type === "startGame" && currentRoom) {
      const roomState = rooms[currentRoom].gameState;

      // Validate room creator by playerName instead of ws
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

    if (currentRoom && !rooms[currentRoom]?.gameState?.started) {
      ws.send(
        JSON.stringify({
          type: "error",
          message: "Game has not started yet.",
        })
      );
      return;
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
