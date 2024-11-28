const express = require("express");
const WebSocket = require("ws");

const app = express();
const server = require("http").createServer(app);
const wss = new WebSocket.Server({ server });

// Use the port provided by Render or default to 3000 for local development
const PORT = process.env.PORT || 3000;

// Serve static frontend files (if needed)
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

  wss.on("headers", (headers, req) => {
    headers.push("Access-Control-Allow-Origin: *"); // Allow all origins
  });

  ws.on("close", () => {
    console.log("A player disconnected");
  });
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
