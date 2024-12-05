const express = require("express");
const WebSocket = require("ws");

const app = express();
const server = require("http").createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

const rowsConfig = {
  red: { start: 2, end: 12 },
  yellow: { start: 2, end: 12 },
  green: { start: 12, end: 2 },
  blue: { start: 12, end: 2 },
};

// Utility to check if a row is ascending (red/yellow) or descending (green/blue)
function isAscendingRow(color) {
  return color === "red" || color === "yellow";
}

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
    penalties: roomState.penalties || {},
    gameOver: roomState.gameOver || false,
  };

  const state = JSON.stringify(gameState);
  rooms[room].clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(state);
    }
  });
}

const rooms = {};

wss.on("connection", (ws) => {
  console.log("A player connected");

  let currentRoom = null;
  let playerName = null;

  function checkGameOver(room) {
    const roomState = rooms[room].gameState;
    if (roomState.gameOver) return; // Already over

    // Game ends if any player has 4 penalties or if two rows locked
    // Count locked rows
    let lockedCount = 0;
    Object.keys(roomState.lockedRows).forEach((c) => {
      if (roomState.lockedRows[c]) lockedCount++;
    });

    let fourPenalties = false;
    Object.keys(roomState.penalties).forEach((p) => {
      if (roomState.penalties[p] >= 4) {
        fourPenalties = true;
      }
    });

    if (fourPenalties || lockedCount >= 2) {
      roomState.gameOver = true;
    }

    if (roomState.gameOver) {
      broadcastGameState(room);
    }
  }

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
            turnMarks: {},
            turnEndedBy: [],
            penalties: {}, // Track penalties per player
            lockedRows: {
              red: false,
              yellow: false,
              green: false,
              blue: false,
            },
            diceActive: { red: true, yellow: true, green: true, blue: true },
            gameOver: false,
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

      const roomState = rooms[room].gameState;
      if (!roomState.players.some((p) => p.name === playerName)) {
        roomState.players.push({ name: playerName });
        roomState.penalties[playerName] = 0; // Initialize penalties
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
      if (roomState.gameOver) {
        ws.send(JSON.stringify({ type: "error", message: "Game is over." }));
        return;
      }

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

        // Roll only active dice
        function rollDie() {
          return Math.floor(Math.random() * 6) + 1;
        }
        let diceValues = {
          white1: rollDie(),
          white2: rollDie(),
        };
        if (roomState.diceActive.red) diceValues.red = rollDie();
        if (roomState.diceActive.yellow) diceValues.yellow = rollDie();
        if (roomState.diceActive.green) diceValues.green = rollDie();
        if (roomState.diceActive.blue) diceValues.blue = rollDie();

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
      if (roomState.gameOver) {
        ws.send(JSON.stringify({ type: "error", message: "Game is over." }));
        return;
      }

      if (!roomState.turnEndedBy.includes(playerName)) {
        roomState.turnEndedBy.push(playerName);
      }

      // If all players ended turn, move to next turn
      if (
        roomState.turnEndedBy.length === roomState.players.length &&
        !roomState.gameOver
      ) {
        // Check if active player marked no cells this turn -> penalty
        const activePlayer = roomState.turnOrder[roomState.activePlayerIndex];
        const tm = roomState.turnMarks[activePlayer];
        if (tm.marksCount === 0) {
          // Active player gets penalty
          roomState.penalties[activePlayer] =
            (roomState.penalties[activePlayer] || 0) + 1;
        }

        checkGameOver(currentRoom);
        if (roomState.gameOver) {
          broadcastGameState(currentRoom);
          return;
        }

        if (!roomState.gameOver) {
          // Advance to next player's turn
          roomState.activePlayerIndex =
            (roomState.activePlayerIndex + 1) % roomState.turnOrder.length;
          roomState.diceRolledThisTurn = false;
          roomState.turnEndedBy = [];
          roomState.turnOrder.forEach((p) => {
            roomState.turnMarks[p] = {
              marksCount: 0,
              firstMarkWasWhiteSum: false,
            };
          });

          checkGameOver(currentRoom);
        }
      }

      broadcastGameState(currentRoom);
    }

    if (data.type === "markCell" && currentRoom) {
      const roomState = rooms[currentRoom].gameState;
      if (roomState.gameOver) {
        ws.send(JSON.stringify({ type: "error", message: "Game is over." }));
        return;
      }

      const { playerName: markPlayerName, color, number } = data;
      if (!roomState.boards[markPlayerName]) {
        roomState.boards[markPlayerName] = {
          red: Array(11).fill(false),
          yellow: Array(11).fill(false),
          green: Array(11).fill(false),
          blue: Array(11).fill(false),
        };
      }

      // Check if row locked
      if (roomState.lockedRows[color]) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: "This row is locked, you cannot mark it.",
          })
        );
        return;
      }

      const isActivePlayer =
        roomState.turnOrder[roomState.activePlayerIndex] === markPlayerName;
      const tm = roomState.turnMarks[markPlayerName] || {
        marksCount: 0,
        firstMarkWasWhiteSum: false,
      };

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
      let validSums = [whiteSum];
      if (isActivePlayer) {
        if (roomState.diceActive.red) {
          validSums.push(
            roomState.diceValues.white1 + roomState.diceValues.red,
            roomState.diceValues.white2 + roomState.diceValues.red
          );
        }
        if (roomState.diceActive.yellow) {
          validSums.push(
            roomState.diceValues.white1 + roomState.diceValues.yellow,
            roomState.diceValues.white2 + roomState.diceValues.yellow
          );
        }
        if (roomState.diceActive.green) {
          validSums.push(
            roomState.diceValues.white1 + roomState.diceValues.green,
            roomState.diceValues.white2 + roomState.diceValues.green
          );
        }
        if (roomState.diceActive.blue) {
          validSums.push(
            roomState.diceValues.white1 + roomState.diceValues.blue,
            roomState.diceValues.white2 + roomState.diceValues.blue
          );
        }
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

      if (!isActivePlayer) {
        // Non-active: only one mark (white sum)
        if (tm.marksCount >= 1) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Non-active player can only mark once per turn.",
            })
          );
          return;
        }
        if (number !== whiteSum) {
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
          tm.firstMarkWasWhiteSum = number === whiteSum;
        } else if (tm.marksCount === 1) {
          if (!tm.firstMarkWasWhiteSum) {
            ws.send(
              JSON.stringify({
                type: "error",
                message:
                  "To make a second mark, the first must have been the white dice sum.",
              })
            );
            return;
          }
          if (number === whiteSum) {
            ws.send(
              JSON.stringify({
                type: "error",
                message:
                  "Second mark must be from a white+color sum (not white sum again).",
              })
            );
            return;
          }
        } else {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "You have already marked two numbers this turn.",
            })
          );
          return;
        }
      }

      // Check ordering constraints
      let index;
      // The final cell is always at index 10 (0-based), since we have 11 numbers.
      if (isAscendingRow(color)) {
        // red/yellow: number - 2 = index
        index = number - 2;
      } else {
        // green/blue: index = 12 - number
        index = 12 - number;
      }

      const rowArray = roomState.boards[markPlayerName][color];
      let previouslyMarkedNumbers = [];
      rowArray.forEach((marked, i) => {
        if (marked) {
          let cellNumber;
          if (isAscendingRow(color)) {
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
        if (isAscendingRow(color) && number < maxMarked) {
          ws.send(
            JSON.stringify({
              type: "error",
              message:
                "You cannot mark a smaller number than one already marked in this row.",
            })
          );
          return;
        }
        if (!isAscendingRow(color) && number > minMarked) {
          ws.send(
            JSON.stringify({
              type: "error",
              message:
                "You cannot mark a larger number than one already marked in this row.",
            })
          );
          return;
        }
      }

      // Check if final number is chosen (12 for red/yellow, 2 for green/blue)
      // Final number is always at index 10
      const finalNumberIndex = 10;
      let finalNumber;
      if (isAscendingRow(color)) finalNumber = 12;
      else finalNumber = 2;

      if (number === finalNumber) {
        // Must have at least 5 other marks before marking final
        const marksInRow = rowArray.filter((x) => x).length;
        if (marksInRow < 5) {
          ws.send(
            JSON.stringify({
              type: "error",
              message:
                "You must have at least 5 marks in this row before marking the final number.",
            })
          );
          return;
        }
      }

      // Mark the cell
      rowArray[index] = true;
      tm.marksCount += 1;
      roomState.turnMarks[markPlayerName] = tm;

      // If final number was chosen, lock the row
      if (number === finalNumber) {
        // Also mark the lock cell automatically (the final cell + 1 in display is just the lock cell visually)
        // The lock cell is not in the array, but we consider the row locked
        roomState.lockedRows[color] = true;
        roomState.diceActive[color] = false;
      }

      broadcastGameState(currentRoom);

      // Check game over conditions
      checkGameOver(currentRoom);
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
