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

function isAscendingRow(color) {
  return color === "red" || color === "yellow";
}

// Scoring table for Qwixx
// numberOfCrosses: score
const scoringTable = {
  0: 0,
  1: 1,
  2: 3,
  3: 6,
  4: 10,
  5: 15,
  6: 21,
  7: 28,
  8: 36,
  9: 45,
  10: 55,
  11: 66,
  12: 78,
};

function calculateScoreForPlayer(playerName, roomState) {
  const colors = ["red", "yellow", "green", "blue"];
  let total = 0;
  let details = {
    redScore: 0,
    yellowScore: 0,
    greenScore: 0,
    blueScore: 0,
    penaltiesScore: 0,
    totalScore: 0,
  };

  colors.forEach((color) => {
    const rowArray = roomState.boards[playerName][color];
    const crosses = rowArray.filter((x) => x).length;
    const score = scoringTable[crosses] || 0;
    details[color + "Score"] = score;
    total += score;
  });

  const penaltyCount = roomState.penalties[playerName] || 0;
  const penaltyPoints = penaltyCount * -5;
  details.penaltiesScore = penaltyPoints;
  total += penaltyPoints;
  details.totalScore = total;

  return details;
}

function computeScoreboard(roomState) {
  const scoreboard = [];
  roomState.players.forEach((p) => {
    const s = calculateScoreForPlayer(p.name, roomState);
    scoreboard.push({ player: p.name, ...s });
  });
  return scoreboard;
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
    scoreboard: roomState.scoreboard || null,
  };

  const state = JSON.stringify(gameState);
  rooms[room].clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(state);
    }
  });
}

const rooms = {};

function checkGameOver(room) {
  const roomState = rooms[room].gameState;
  if (roomState.gameOver) return;

  // Check conditions
  // 1) Any player has 4 penalties
  let fourPenalties = false;
  Object.keys(roomState.penalties).forEach((p) => {
    if (roomState.penalties[p] >= 4) {
      fourPenalties = true;
    }
  });

  // 2) Two rows locked
  let lockedCount = 0;
  Object.keys(roomState.lockedRows).forEach((c) => {
    if (roomState.lockedRows[c]) lockedCount++;
  });

  if (fourPenalties || lockedCount >= 2) {
    roomState.gameOver = true;
    // Compute scoreboard
    roomState.scoreboard = computeScoreboard(roomState);
  }
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
            turnMarks: {},
            turnEndedBy: [],
            penalties: {},
            lockedRows: {
              red: false,
              yellow: false,
              green: false,
              blue: false,
            },
            diceActive: { red: true, yellow: true, green: true, blue: true },
            gameOver: false,
            scoreboard: null,
          },
          clients: [],
          roomCreator: playerName,
        };

        ws.send(JSON.stringify({ type: "newGame", room }));
        console.log(`Room ${room} created by ${playerName}`);
      }

      const roomState = rooms[room].gameState;
      if (roomState.started) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: "Game has already started.",
          })
        );
        return;
      }

      if (!roomState.players.some((p) => p.name === playerName)) {
        roomState.players.push({ name: playerName });
        roomState.penalties[playerName] = 0;
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

      if (
        roomState.turnEndedBy.length === roomState.players.length &&
        !roomState.gameOver
      ) {
        // Check if active player made no marks this turn
        const activePlayer = roomState.turnOrder[roomState.activePlayerIndex];
        const tm = roomState.turnMarks[activePlayer];
        if (tm.marksCount === 0) {
          // Active player penalty
          roomState.penalties[activePlayer] =
            (roomState.penalties[activePlayer] || 0) + 1;
        }

        checkGameOver(currentRoom);
        if (roomState.gameOver) {
          broadcastGameState(currentRoom);
          return;
        }

        // Move to next turn
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

      if (!roomState.diceRolledThisTurn) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: "You cannot mark before dice are rolled this turn.",
          })
        );
        return;
      }

      if (roomState.lockedRows[color]) {
        ws.send(
          JSON.stringify({ type: "error", message: "This row is locked." })
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

      function colorDiceActive(color) {
        return roomState.diceActive[color];
      }

      if (isActivePlayer) {
        if (colorDiceActive("red")) {
          validSums.push(
            roomState.diceValues.white1 + roomState.diceValues.red,
            roomState.diceValues.white2 + roomState.diceValues.red
          );
        }
        if (colorDiceActive("yellow")) {
          validSums.push(
            roomState.diceValues.white1 + roomState.diceValues.yellow,
            roomState.diceValues.white2 + roomState.diceValues.yellow
          );
        }
        if (colorDiceActive("green")) {
          validSums.push(
            roomState.diceValues.white1 + roomState.diceValues.green,
            roomState.diceValues.white2 + roomState.diceValues.green
          );
        }
        if (colorDiceActive("blue")) {
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
        if (tm.marksCount === 0) {
          tm.firstMarkWasWhiteSum = number === whiteSum;
        } else if (tm.marksCount === 1) {
          if (!tm.firstMarkWasWhiteSum) {
            ws.send(
              JSON.stringify({
                type: "error",
                message:
                  "To make a second mark, the first must be the white dice sum.",
              })
            );
            return;
          }
          if (number === whiteSum) {
            ws.send(
              JSON.stringify({
                type: "error",
                message:
                  "Second mark must be a white+color sum, not white sum again.",
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

      let index;
      if (isAscendingRow(color)) {
        index = number - 2;
      } else {
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
              message: "Cannot mark a smaller number than one already marked.",
            })
          );
          return;
        }
        if (!isAscendingRow(color) && number > minMarked) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Cannot mark a larger number than one already marked.",
            })
          );
          return;
        }
      }

      // Check if final number
      let finalNumber = isAscendingRow(color) ? 12 : 2;
      if (number === finalNumber) {
        const marksInRow = rowArray.filter((x) => x).length;
        if (marksInRow < 5) {
          ws.send(
            JSON.stringify({
              type: "error",
              message:
                "You must have at least 5 marks before marking the final number.",
            })
          );
          return;
        }
      }

      // Mark the cell
      rowArray[index] = true;
      tm.marksCount += 1;
      roomState.turnMarks[markPlayerName] = tm;

      if (number === finalNumber) {
        roomState.lockedRows[color] = true;
        roomState.diceActive[color] = false;
      }

      broadcastGameState(currentRoom);

      // Check game over now that a mark was made
      checkGameOver(currentRoom);
      if (roomState.gameOver) {
        broadcastGameState(currentRoom);
      }
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
