const express = require("express");
const WebSocket = require("ws");

const app = express();
const server = require("http").createServer(app);
const wss = new WebSocket.Server({ server });

// Use the port provided by Render or default to 3000 for local development
const PORT = process.env.PORT || 3000;

// Serve static frontend files (if needed)
app.use(express.static("public"));

// Rooms and their game states
const rooms = {};

// Broadcast the updated game state to all clients in a room
function broadcastGameState(room) {
  const state = JSON.stringify(rooms[room].gameState);
  rooms[room].clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(state);
    }
  });
}

wss.on("connection", (ws) => {
  console.log("A player connected");

  let currentRoom = null;

  // Handle messages from clients
  ws.on("message", (message) => {
    const data = JSON.parse(message);

    // Join or create a room
    if (data.type === "joinRoom") {
      const room = data.passcode;

      // If the room doesn't exist, create it
      if (!rooms[room]) {
        rooms[room] = {
          gameState: {
            diceValues: {
              white1: 0,
              white2: 0,
              red: 0,
              yellow: 0,
              green: 0,
              blue: 0,
            },
            scoreSheets: {}, // Player-specific scores
          },
          clients: [],
        };
        console.log(`Room ${room} created.`);
        // Notify the client that the room was created
        ws.send(
          JSON.stringify({
            type: "roomStatus",
            room,
            status: "created",
          })
        );
      } else {
        console.log(`Player joined existing room: ${room}`);
        // Notify the client that the room was joined
        ws.send(
          JSON.stringify({
            type: "roomStatus",
            room,
            status: "joined",
          })
        );
      }

      // Join the room
      rooms[room].clients.push(ws);
      currentRoom = room;

      // Send the current game state to the player
      ws.send(JSON.stringify(rooms[room].gameState));
    }

    // Handle game actions (e.g., rolling dice, updating scores)
    if (currentRoom) {
      if (data.type === "rollDice") {
        rooms[currentRoom].gameState.diceValues = data.diceValues;
      } else if (data.type === "updateScore") {
        rooms[currentRoom].gameState.scoreSheets[data.playerId] =
          data.scoreSheet;
      }

      // Broadcast the updated game state to the room
      broadcastGameState(currentRoom);
    }
  });

  // Handle disconnection
  ws.on("close", () => {
    if (currentRoom) {
      rooms[currentRoom].clients = rooms[currentRoom].clients.filter(
        (client) => client !== ws
      );
      console.log(`Player left room: ${currentRoom}`);

      // If the room is empty, delete it
      if (rooms[currentRoom].clients.length === 0) {
        delete rooms[currentRoom];
        console.log(`Room ${currentRoom} deleted.`);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
