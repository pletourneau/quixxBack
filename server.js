const express = require("express");
const WebSocket = require("ws");

const app = express();
const server = require("http").createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

const rooms = {};

function broadcastGameState(room) {
  const roomState = rooms[room].gameState;
  const gameState = {
    type: "gameState",
    started: roomState.started,
    players: roomState.players.map((player) => ({ name: player.name })),
    turnOrder: roomState.turnOrder,
    activePlayerIndex: roomState.activePlayerIndex,
    diceValues: roomState.diceValues || null,
    boards: roomState.boards || {},
    diceRolledThisTurn: roomState.diceRolledThisTurn || false,
    turnEndedBy: roomState.turnEndedBy || [],
  };

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
            boards: {},
            diceRolledThisTurn: false,
            turnMarks: {}, // Track marks per player per turn
            turnEndedBy: [],
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
      broadcastGameState(room);
    }

    if (data.type === "startGame" && currentRoom) {
      const roomState = rooms[currentRoom].gameState;
      if (rooms[currentRoom].roomCreator === playerName) {
        roomState.turnOrder = data.turnOrder;
        roomState.activePlayerIndex = Math.floor(
          Math.random() * roomState.turnOrder.length
        );
        roomState.started = true;
        // Initialize turnMarks for all players
        roomState.turnMarks = {};
        roomState.turnOrder.forEach((p) => {
          roomState.turnMarks[p] = {
            marksCount: 0,
            firstMarkWasWhiteSum: false,
          };
        });
        roomState.turnEndedBy = [];
        roomState.diceRolledThisTurn = false;
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

    if (data.type === "rollDice" && currentRoom) {
      const roomState = rooms[currentRoom].gameState;
      const activePlayer = roomState.turnOrder[roomState.activePlayerIndex];

      if (activePlayer === playerName) {
        if (roomState.diceRolledThisTurn) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "You have already rolled the dice this turn.",
            })
          );
          return;
        }

        const diceValues = {
          white1: Math.floor(Math.random() * 6) + 1,
          white2: Math.floor(Math.random() * 6) + 1,
          red: Math.floor(Math.random() * 6) + 1,
          yellow: Math.floor(Math.random() * 6) + 1,
          green: Math.floor(Math.random() * 6) + 1,
          blue: Math.floor(Math.random() * 6) + 1,
        };

        roomState.diceValues = diceValues;
        roomState.diceRolledThisTurn = true;

        console.log(`Dice rolled by ${playerName}:`, diceValues);
        broadcastGameState(currentRoom);
      } else {
        ws.send(
          JSON.stringify({
            type: "error",
            message: "You are not the active player.",
          })
        );
      }
    }

    if (data.type === "endTurn" && currentRoom) {
      const roomState = rooms[currentRoom].gameState;
      const activePlayer = roomState.turnOrder[roomState.activePlayerIndex];
      if (activePlayer === playerName) {
        roomState.activePlayerIndex =
          (roomState.activePlayerIndex + 1) % roomState.turnOrder.length;
        // Reset diceRolledThisTurn and turnMarks for the next turn
        roomState.diceRolledThisTurn = false;
        roomState.turnEndedBy.push(playerName);
        // Reset marksCount for all players next turn
        roomState.turnOrder.forEach((p) => {
          roomState.turnMarks[p] = {
            marksCount: 0,
            firstMarkWasWhiteSum: false,
          };
        });
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

    if (data.type === "markCell" && currentRoom) {
      const roomState = rooms[currentRoom].gameState;
      const { playerName: markPlayerName, color, number, sumType } = data;

      if (!roomState.boards[markPlayerName]) {
        roomState.boards[markPlayerName] = {
          red: Array(11).fill(false),
          yellow: Array(11).fill(false),
          green: Array(11).fill(false),
          blue: Array(11).fill(false),
        };
      }

      const isActivePlayer =
        roomState.turnOrder[roomState.activePlayerIndex] === markPlayerName;

      // Validate chosen sum
      if (!roomState.diceValues) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: "No dice values rolled this turn.",
          })
        );
        return;
      }

      const whiteSum =
        roomState.diceValues.white1 + roomState.diceValues.white2;
      let validSums = [whiteSum]; // always can choose white sum
      // white+color sums
      if (isActivePlayer) {
        validSums.push(
          roomState.diceValues.white1 + roomState.diceValues.red,
          roomState.diceValues.white2 + roomState.diceValues.red,
          roomState.diceValues.white1 + roomState.diceValues.yellow,
          roomState.diceValues.white2 + roomState.diceValues.yellow,
          roomState.diceValues.white1 + roomState.diceValues.green,
          roomState.diceValues.white2 + roomState.diceValues.green,
          roomState.diceValues.white1 + roomState.diceValues.blue,
          roomState.diceValues.white2 + roomState.diceValues.blue
        );
      }

      if (!validSums.includes(number)) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: "Chosen cell does not match any allowed sums.",
          })
        );
        return;
      }

      // Check marking rules
      const tm = roomState.turnMarks[markPlayerName];
      if (!tm) {
        // If somehow not initialized, init now
        roomState.turnMarks[markPlayerName] = {
          marksCount: 0,
          firstMarkWasWhiteSum: false,
        };
      }

      // Non-active player rules
      if (!isActivePlayer) {
        // Non-active: only one mark (white sum)
        if (tm.marksCount >= 1) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Non-active player can only mark once.",
            })
          );
          return;
        }
        // Must be white sum
        if (sumType !== "white" || number !== whiteSum) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Non-active player must mark the white dice sum.",
            })
          );
          return;
        }
      } else {
        // Active player rules
        if (tm.marksCount === 0) {
          // First mark of this turn
          // If they choose white sum first, firstMarkWasWhiteSum = true
          // If color sum first, firstMarkWasWhiteSum = false and they can't do a second mark
          tm.firstMarkWasWhiteSum = sumType === "white" && number === whiteSum;
          // If they chose color sum first, that means only one mark this turn
        } else if (tm.marksCount === 1) {
          // Second mark attempt
          if (!tm.firstMarkWasWhiteSum) {
            // If first was not white sum, can't do second mark
            ws.send(
              JSON.stringify({
                type: "error",
                message:
                  "Second mark not allowed since first wasn't white sum.",
              })
            );
            return;
          }
          // If first was white sum, second must be a color sum if they want two
          if (
            tm.firstMarkWasWhiteSum &&
            sumType === "white" &&
            number === whiteSum
          ) {
            // second mark is white sum again? Not allowed by the new rules
            // They said second mark optional can be white+color sum, not white sum again
            ws.send(
              JSON.stringify({
                type: "error",
                message: "Second mark must be from a white+color sum.",
              })
            );
            return;
          }
        } else {
          // Already made two marks this turn
          ws.send(
            JSON.stringify({
              type: "error",
              message: "You have already marked two numbers this turn.",
            })
          );
          return;
        }
      }

      // Check order constraints
      // Convert color/number to index
      let index;
      if (color === "red" || color === "yellow") {
        index = number - 2; // array from 2..12
      } else {
        index = 12 - number; // array from 12..2
      }

      // Check ordering:
      // For red/yellow: must mark a number >= all previously marked
      // means: chosen number >= max previously marked number
      // For green/blue: chosen number <= min previously marked number
      const rowArray = roomState.boards[markPlayerName][color];
      let previouslyMarkedNumbers = [];
      rowArray.forEach((marked, i) => {
        if (marked) {
          let cellNumber;
          if (color === "red" || color === "yellow") {
            cellNumber = i + 2;
          } else {
            cellNumber = 12 - i;
          }
          previouslyMarkedNumbers.push(cellNumber);
        }
      });

      if (previouslyMarkedNumbers.length > 0) {
        const maxMarked = Math.max(...previouslyMarkedNumbers);
        const minMarked = Math.min(...previouslyMarkedNumbers);
        if (color === "red" || color === "yellow") {
          // chosen number >= maxMarked
          if (number < maxMarked) {
            ws.send(
              JSON.stringify({
                type: "error",
                message:
                  "You cannot mark a number smaller than one already marked in red/yellow.",
              })
            );
            return;
          }
        } else {
          // green/blue
          // chosen number <= minMarked
          if (number > minMarked) {
            ws.send(
              JSON.stringify({
                type: "error",
                message:
                  "You cannot mark a number larger than one already marked in green/blue.",
              })
            );
            return;
          }
        }
      }

      // All checks passed, mark the cell
      rowArray[index] = true;
      tm.marksCount += 1;

      console.log(
        `${markPlayerName} marked ${color} cell ${number}. marksCount=${tm.marksCount}, firstWhite=${tm.firstMarkWasWhiteSum}`
      );
      broadcastGameState(currentRoom);
    }
  });

  ws.on("close", () => {
    if (currentRoom && playerName) {
      const roomState = rooms[currentRoom].gameState;
      rooms[currentRoom].clients = rooms[currentRoom].clients.filter(
        (c) => c !== ws
      );
      roomState.players = roomState.players.filter(
        (p) => p.name !== playerName
      );

      if (roomState.turnOrder && roomState.turnOrder.includes(playerName)) {
        roomState.turnOrder = roomState.turnOrder.filter(
          (n) => n !== playerName
        );
        if (roomState.activePlayerIndex >= roomState.turnOrder.length) {
          roomState.activePlayerIndex = 0;
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
