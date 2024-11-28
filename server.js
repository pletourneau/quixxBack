const express = require("express");
const WebSocket = require("ws");

const app = express();
const server = require("http").createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static frontend files
app.use(express.static("public"));

let gameState = {}; // Store the game state

wss.on("connection", (ws) => {
  console.log("A player connected");

  // Send initial state
  ws.send(JSON.stringify(gameState));

  // Receive updates
  ws.on("message", (message) => {
    const data = JSON.parse(message);

    // Update game state
    gameState = { ...gameState, ...data };

    // Broadcast updated state to all players
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(gameState));
      }
    });
  });

  ws.on("close", () => {
    console.log("A player disconnected");
  });
});

server.listen(3000, () => {
  console.log("Server is running on http://localhost:3000");
});
