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

// Scoring table
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

  let fourPenalties = false;
  Object.keys(roomState.penalties).forEach((p) => {
    if (roomState.penalties[p] >= 4) fourPenalties = true;
  });

  let lockedCount = 0;
  Object.keys(roomState.lockedRows).forEach((c) => {
    if (roomState.lockedRows[c]) lockedCount++;
  });

  if (fourPenalties || lockedCount >= 2) {
    roomState.gameOver = true;
    roomState.scoreboard = computeScoreboard(roomState);
  }
}

wss.on("connection", (ws) => {
  console.log("A player connected");

  let currentRoom = null;
  let playerName = null;

  function sendErrorAndState(msg) {
    ws.send(JSON.stringify({ type: "error", message: msg }));
    if (currentRoom) {
      broadcastGameState(currentRoom);
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
        sendErrorAndState("Game has already started.");
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
        sendErrorAndState("Only the room creator can start the game.");
      }
    }

    if (data.type === "rollDice" && currentRoom) {
      const roomState = rooms[currentRoom].gameState;
      if (roomState.gameOver) {
        sendErrorAndState("Game is over.");
        return;
      }

      const activePlayer = roomState.turnOrder[roomState.activePlayerIndex];
      if (activePlayer === playerName) {
        if (roomState.diceRolledThisTurn) {
          sendErrorAndState("Dice have already been rolled this turn.");
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
        sendErrorAndState("You are not the active player.");
      }
    }

    if (data.type === "endTurn" && currentRoom) {
      const roomState = rooms[currentRoom].gameState;
      if (roomState.gameOver) {
        sendErrorAndState("Game is over.");
        return;
      }

      const marks = data.marks || [];
      if (roomState.diceRolledThisTurn) {
        const activePlayer = roomState.turnOrder[roomState.activePlayerIndex];
        const tm = roomState.turnMarks[activePlayer];

        let newBoards = JSON.parse(JSON.stringify(roomState.boards));
        let localTM = {
          marksCount: tm.marksCount,
          firstMarkWasWhiteSum: tm.firstMarkWasWhiteSum,
        };

        const whiteSum =
          roomState.diceValues.white1 + roomState.diceValues.white2;
        let validSums = [whiteSum];
        let sumToColors = {};
        sumToColors[whiteSum] = ["white"];

        function addColorSum(num, color) {
          if (!sumToColors[num]) sumToColors[num] = [];
          if (!sumToColors[num].includes(color)) sumToColors[num].push(color);
        }

        const addIfActive = (c, val1, val2) => {
          if (roomState.diceActive[c]) {
            validSums.push(val1, val2);
            addColorSum(val1, c);
            addColorSum(val2, c);
          }
        };

        if (roomState.diceActive.red) {
          const val1 =
            roomState.diceValues.white1 + (roomState.diceValues.red || 0);
          const val2 =
            roomState.diceValues.white2 + (roomState.diceValues.red || 0);
          addIfActive("red", val1, val2);
        }
        if (roomState.diceActive.yellow) {
          const val1 =
            roomState.diceValues.white1 + (roomState.diceValues.yellow || 0);
          const val2 =
            roomState.diceValues.white2 + (roomState.diceValues.yellow || 0);
          addIfActive("yellow", val1, val2);
        }
        if (roomState.diceActive.green) {
          const val1 =
            roomState.diceValues.white1 + (roomState.diceValues.green || 0);
          const val2 =
            roomState.diceValues.white2 + (roomState.diceValues.green || 0);
          addIfActive("green", val1, val2);
        }
        if (roomState.diceActive.blue) {
          const val1 =
            roomState.diceValues.white1 + (roomState.diceValues.blue || 0);
          const val2 =
            roomState.diceValues.white2 + (roomState.diceValues.blue || 0);
          addIfActive("blue", val1, val2);
        }

        for (const mark of marks) {
          const { color, number } = mark;

          if (roomState.lockedRows[color]) {
            sendErrorAndState("This row is locked.");
            return;
          }

          if (!validSums.includes(number)) {
            sendErrorAndState("Chosen cell does not match any allowed sums.");
            return;
          }

          const rowArray = newBoards[activePlayer][color];
          let index;
          if (isAscendingRow(color)) {
            index = number - 2;
          } else {
            index = 12 - number;
          }

          if (rowArray[index]) {
            sendErrorAndState("Cell already marked.");
            return;
          }

          let previouslyMarkedNumbers = [];
          rowArray.forEach((marked, i) => {
            if (marked) {
              let cellNumber;
              if (isAscendingRow(color)) cellNumber = i + 2;
              else cellNumber = 12 - i;
              previouslyMarkedNumbers.push(cellNumber);
            }
          });

          if (previouslyMarkedNumbers.length > 0) {
            const maxMarked = Math.max(...previouslyMarkedNumbers);
            const minMarked = Math.min(...previouslyMarkedNumbers);
            if (isAscendingRow(color) && number < maxMarked) {
              sendErrorAndState(
                "Cannot mark a smaller number than one already marked."
              );
              return;
            }
            if (!isAscendingRow(color) && number > minMarked) {
              sendErrorAndState(
                "Cannot mark a larger number than one already marked."
              );
              return;
            }
          }

          const isActivePlayerTurn = activePlayer === playerName;
          if (!isActivePlayerTurn) {
            if (localTM.marksCount >= 1) {
              sendErrorAndState(
                "Non-active player can only mark once per turn."
              );
              return;
            }
            if (number !== whiteSum) {
              sendErrorAndState(
                "Non-active player must mark the white dice sum."
              );
              return;
            }
          } else {
            if (localTM.marksCount === 0) {
              localTM.firstMarkWasWhiteSum = number === whiteSum;
            } else if (localTM.marksCount === 1) {
              if (!localTM.firstMarkWasWhiteSum) {
                sendErrorAndState(
                  "To make a second mark, the first must be the white dice sum."
                );
                return;
              }
              if (number === whiteSum) {
                sendErrorAndState(
                  "Second mark must be a white+color sum, not white sum again."
                );
                return;
              }
            } else {
              sendErrorAndState(
                "You have already marked two numbers this turn."
              );
              return;
            }
          }

          // Check if number != whiteSum means color sum must match the row color
          if (number !== whiteSum) {
            const possibleColors = sumToColors[number];
            if (!possibleColors || !possibleColors.includes(color)) {
              sendErrorAndState(
                "For a white+color sum, you must mark the row of that color."
              );
              return;
            }
          }

          let finalNumber = isAscendingRow(color) ? 12 : 2;
          if (number === finalNumber) {
            const marksInRow = rowArray.filter((x) => x).length;
            if (marksInRow < 5) {
              sendErrorAndState(
                "You must have at least 5 marks before marking the final number."
              );
              return;
            }
          }

          rowArray[index] = true;
          localTM.marksCount += 1;

          if (number === finalNumber) {
            roomState.lockedRows[color] = true;
            roomState.diceActive[color] = false;
          }
        }

        roomState.boards = newBoards;
        roomState.turnMarks[activePlayer] = localTM;
      } else {
        const activePlayer = roomState.turnOrder[roomState.activePlayerIndex];
        const tm = roomState.turnMarks[activePlayer];
        if (tm.marksCount === 0 && marks.length > 0) {
          sendErrorAndState("No dice rolled this turn, cannot mark.");
          return;
        }
        if (tm.marksCount === 0 && marks.length === 0) {
          roomState.penalties[activePlayer] =
            (roomState.penalties[activePlayer] || 0) + 1;
        }
      }

      if (!roomState.turnEndedBy.includes(playerName)) {
        roomState.turnEndedBy.push(playerName);
      }

      if (
        roomState.turnEndedBy.length === roomState.players.length &&
        !roomState.gameOver
      ) {
        checkGameOver(currentRoom);
        if (roomState.gameOver) {
          broadcastGameState(currentRoom);
          return;
        }

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
