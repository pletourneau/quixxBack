const express = require("express");
const WebSocket = require("ws");

const app = express();
const server = require("http").createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Server is running and ready for WebSocket connections!");
});

// Row config (start/end) just for reference
const rowsConfig = {
  red: { start: 2, end: 12 },
  yellow: { start: 2, end: 12 },
  green: { start: 12, end: 2 },
  blue: { start: 12, end: 2 },
};

function isAscendingRow(color) {
  return color === "red" || color === "yellow";
}

// Standard scoring table
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

// If row is locked by a player, treat it as one extra mark only for that player
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
    // Count how many crosses the player has
    let crosses = rowArray.filter((x) => x).length;

    // Only add +1 if this color was locked by *this* player
    if (roomState.lockedRows[color] === playerName) {
      crosses += 1;
    }

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
    players: roomState.players.map((player) => ({
      name: player.name,
      connected: rooms[room].playersByName[player.name].connected,
    })),
    turnOrder: roomState.turnOrder,
    activePlayerIndex: roomState.activePlayerIndex,
    diceValues: roomState.diceValues || null,
    boards: roomState.boards || {},
    diceRolledThisTurn: roomState.diceRolledThisTurn || false,
    turnEndedBy: roomState.turnEndedBy || [],
    penalties: roomState.penalties || {},
    lockedRows: roomState.lockedRows || {}, // now stores playerName or null
    diceActive: roomState.diceActive || {},
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

  // End if any player hits 4 penalties
  let fourPenalties = false;
  Object.keys(roomState.penalties).forEach((p) => {
    if (roomState.penalties[p] >= 4) {
      fourPenalties = true;
    }
  });

  // Or if 2 rows are locked (by anyone)
  let lockedCount = 0;
  Object.keys(roomState.lockedRows).forEach((c) => {
    // If lockedRows[c] is a playerName, row is locked
    if (roomState.lockedRows[c]) {
      lockedCount++;
    }
  });

  if (fourPenalties || lockedCount >= 2) {
    roomState.gameOver = true;
    roomState.scoreboard = computeScoreboard(roomState);
    console.log(`Game Over in room ${room}:`, roomState.scoreboard);

    // After gameOver is set, we broadcast once more
    broadcastGameState(room);

    // ======= ADD CLEANUP LOGIC HERE =======
    // Example: after 10 seconds, remove the room from rooms.
    setTimeout(() => {
      delete rooms[room];
      console.log(`Room ${room} deleted after game over.`);
    }, 10000);
  }
}

function sendErrorAndState(ws, room, msg) {
  ws.send(JSON.stringify({ type: "error", message: msg }));
  if (room) broadcastGameState(room);
}

function cloneBoards(boards) {
  const clone = {};
  for (let player in boards) {
    clone[player] = {
      red: [...boards[player].red],
      yellow: [...boards[player].yellow],
      green: [...boards[player].green],
      blue: [...boards[player].blue],
    };
  }
  return clone;
}

function cloneTurnMarks(turnMarks) {
  const clone = {};
  for (let player in turnMarks) {
    clone[player] = {
      marksCount: turnMarks[player].marksCount,
      firstMarkWasWhiteSum: turnMarks[player].firstMarkWasWhiteSum,
    };
  }
  return clone;
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
        // Create a new room
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
            // Instead of booleans, store the name of the player who locked
            lockedRows: {
              red: null,
              yellow: null,
              green: null,
              blue: null,
            },
            diceActive: {
              red: true,
              yellow: true,
              green: true,
              blue: true,
            },
            gameOver: false,
            scoreboard: null,
            rowsToLock: {},
            turnStartBoards: null,
            turnStartMarks: null,
          },
          clients: [],
          playersByName: {},
          roomCreator: playerName,
        };

        ws.send(JSON.stringify({ type: "newGame", room }));
        console.log(`Room ${room} created by ${playerName}`);
      }

      const roomState = rooms[room].gameState;
      const roomData = rooms[room];

      // If game already started, check for reconnection
      if (roomState.started) {
        if (roomData.playersByName[playerName]) {
          // Known player
          if (!roomData.playersByName[playerName].connected) {
            // Reconnecting
            roomData.playersByName[playerName].connected = true;
            roomData.playersByName[playerName].ws = ws;
            roomData.clients.push(ws);
            currentRoom = room;
            console.log(`${playerName} reconnected to room: ${room}`);
            broadcastGameState(room);
          } else {
            // Already connected
            sendErrorAndState(ws, room, "You are already connected.");
          }
        } else {
          // New player, but game in progress => reject
          sendErrorAndState(ws, room, "Game has already started.");
        }
        return;
      }

      // If game not started, allow joining
      if (!roomState.players.some((p) => p.name === playerName)) {
        roomState.players.push({ name: playerName });
        roomState.penalties[playerName] = 0;
        roomState.boards[playerName] = {
          red: Array(11).fill(false),
          yellow: Array(11).fill(false),
          green: Array(11).fill(false),
          blue: Array(11).fill(false),
        };
      }

      roomData.playersByName[playerName] = {
        ws,
        connected: true,
      };

      roomData.clients.push(ws);
      currentRoom = room;

      console.log(`${playerName} joined room: ${room}`);
      broadcastGameState(room);
    }

    // Start Game
    if (data.type === "startGame" && currentRoom) {
      const roomState = rooms[currentRoom].gameState;
      const roomData = rooms[currentRoom];
      if (roomData.roomCreator === playerName) {
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
        roomState.turnStartBoards = cloneBoards(roomState.boards);
        roomState.turnStartMarks = cloneTurnMarks(roomState.turnMarks);

        broadcastGameState(currentRoom);
      } else {
        sendErrorAndState(ws, currentRoom, "Only the room creator can start.");
      }
    }

    // Roll Dice
    if (data.type === "rollDice" && currentRoom) {
      const roomState = rooms[currentRoom].gameState;
      if (roomState.gameOver) {
        sendErrorAndState(ws, currentRoom, "Game is over.");
        return;
      }
      const activePlayer = roomState.turnOrder[roomState.activePlayerIndex];
      if (activePlayer === playerName) {
        if (roomState.diceRolledThisTurn) {
          sendErrorAndState(ws, currentRoom, "Dice already rolled this turn.");
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

        roomState.turnStartBoards = cloneBoards(roomState.boards);
        roomState.turnStartMarks = cloneTurnMarks(roomState.turnMarks);

        console.log(`Dice rolled by ${playerName}:`, diceValues);
        broadcastGameState(currentRoom);
      } else {
        sendErrorAndState(ws, currentRoom, "Not the active player.");
      }
    }

    // Mark Cell
    if (data.type === "markCell" && currentRoom) {
      const roomState = rooms[currentRoom].gameState;
      if (roomState.gameOver) {
        sendErrorAndState(ws, currentRoom, "Game is over.");
        return;
      }

      const { playerName: markPlayerName, color, number } = data;
      if (!roomState.diceRolledThisTurn) {
        sendErrorAndState(ws, currentRoom, "Dice not rolled this turn yet.");
        return;
      }
      if (!roomState.boards[markPlayerName]) {
        sendErrorAndState(ws, currentRoom, "Player board not found.");
        return;
      }
      if (roomState.lockedRows[color]) {
        // If lockedRows[color] is *any* player, row is locked for all
        sendErrorAndState(ws, currentRoom, "This row is locked.");
        return;
      }

      const activePlayer = roomState.turnOrder[roomState.activePlayerIndex];
      const tm = roomState.turnMarks[markPlayerName] || {
        marksCount: 0,
        firstMarkWasWhiteSum: false,
      };
      const isActivePlayer = activePlayer === markPlayerName;

      if (!roomState.diceValues) {
        sendErrorAndState(ws, currentRoom, "No dice values this turn.");
        return;
      }

      // Summaries
      const whiteSum =
        roomState.diceValues.white1 + roomState.diceValues.white2;

      let validSums = [whiteSum];
      let sumToColors = {};
      sumToColors[whiteSum] = ["white"];

      function addColorSum(num, cc) {
        if (!sumToColors[num]) sumToColors[num] = [];
        if (!sumToColors[num].includes(cc)) {
          sumToColors[num].push(cc);
        }
      }

      function addIfActive(cc, val1, val2) {
        if (roomState.diceActive[cc]) {
          validSums.push(val1, val2);
          addColorSum(val1, cc);
          addColorSum(val2, cc);
        }
      }

      // Build color sums
      if (roomState.diceActive.red) {
        let val1 =
          roomState.diceValues.white1 + (roomState.diceValues.red || 0);
        let val2 =
          roomState.diceValues.white2 + (roomState.diceValues.red || 0);
        addIfActive("red", val1, val2);
      }
      if (roomState.diceActive.yellow) {
        let val1 =
          roomState.diceValues.white1 + (roomState.diceValues.yellow || 0);
        let val2 =
          roomState.diceValues.white2 + (roomState.diceValues.yellow || 0);
        addIfActive("yellow", val1, val2);
      }
      if (roomState.diceActive.green) {
        let val1 =
          roomState.diceValues.white1 + (roomState.diceValues.green || 0);
        let val2 =
          roomState.diceValues.white2 + (roomState.diceValues.green || 0);
        addIfActive("green", val1, val2);
      }
      if (roomState.diceActive.blue) {
        let val1 =
          roomState.diceValues.white1 + (roomState.diceValues.blue || 0);
        let val2 =
          roomState.diceValues.white2 + (roomState.diceValues.blue || 0);
        addIfActive("blue", val1, val2);
      }

      // 1) Check if number in valid sums
      if (!validSums.includes(number)) {
        sendErrorAndState(ws, currentRoom, "Chosen cell not in allowed sums.");
        return;
      }

      // 2) If not whiteSum, ensure color is in sumToColors[number]
      if (number !== whiteSum) {
        const possibleColors = sumToColors[number] || [];
        if (!possibleColors.includes(color)) {
          sendErrorAndState(
            ws,
            currentRoom,
            `Color "${color}" with ${number} is not valid.`
          );
          return;
        }
      }

      const rowArray = roomState.boards[markPlayerName][color];
      let index;
      if (isAscendingRow(color)) {
        index = number - 2;
      } else {
        index = 12 - number;
      }

      if (rowArray[index]) {
        sendErrorAndState(ws, currentRoom, "Cell already marked.");
        return;
      }

      // Must not mark smaller or bigger than existing ones
      let previouslyMarkedNumbers = [];
      rowArray.forEach((marked, i) => {
        if (marked) {
          let cellNumber = isAscendingRow(color) ? i + 2 : 12 - i;
          previouslyMarkedNumbers.push(cellNumber);
        }
      });

      if (previouslyMarkedNumbers.length > 0) {
        const maxMarked = Math.max(...previouslyMarkedNumbers);
        const minMarked = Math.min(...previouslyMarkedNumbers);
        if (isAscendingRow(color) && number < maxMarked) {
          sendErrorAndState(ws, currentRoom, "Cannot mark smaller than max.");
          return;
        }
        if (!isAscendingRow(color) && number > minMarked) {
          sendErrorAndState(ws, currentRoom, "Cannot mark larger than min.");
          return;
        }
      }

      // Non-active player can only mark once, white sum only
      if (!isActivePlayer) {
        if (tm.marksCount >= 1) {
          sendErrorAndState(
            ws,
            currentRoom,
            "Non-active player can only mark once per turn."
          );
          return;
        }
        if (number !== whiteSum) {
          sendErrorAndState(ws, currentRoom, "Must mark the white dice sum.");
          return;
        }
      } else {
        // Active player can mark up to 2 times
        if (tm.marksCount === 0) {
          tm.firstMarkWasWhiteSum = number === whiteSum;
        } else if (tm.marksCount === 1) {
          // second mark only if first was white sum
          if (!tm.firstMarkWasWhiteSum) {
            sendErrorAndState(
              ws,
              currentRoom,
              "Second mark requires first was white sum."
            );
            return;
          }
          const possibleColorsNow = sumToColors[number];
          const hasNonWhite =
            possibleColorsNow && possibleColorsNow.some((c) => c !== "white");
          if (!hasNonWhite && number !== whiteSum) {
            sendErrorAndState(
              ws,
              currentRoom,
              "Second mark must be from white+color sum."
            );
            return;
          }
        } else {
          sendErrorAndState(
            ws,
            currentRoom,
            "You already marked two numbers this turn."
          );
          return;
        }
      }

      // If final number => check 5 marks then lock row for this player
      let finalNumber = isAscendingRow(color) ? 12 : 2;
      if (number === finalNumber) {
        const marksInRow = rowArray.filter((x) => x).length;
        if (marksInRow < 5) {
          sendErrorAndState(
            ws,
            currentRoom,
            "Need at least 5 marks before final number."
          );
          return;
        }
        // Instead of lockedRows[color] = true,
        // store the player's name
        roomState.rowsToLock[color] = markPlayerName;
      }

      // Mark cell
      rowArray[index] = true;
      tm.marksCount += 1;
      roomState.turnMarks[markPlayerName] = tm;

      broadcastGameState(currentRoom);
    }

    // End Turn
    if (data.type === "endTurn" && currentRoom) {
      const roomState = rooms[currentRoom].gameState;
      if (roomState.gameOver) {
        sendErrorAndState(ws, currentRoom, "Game is over.");
        return;
      }

      const activePlayer = roomState.turnOrder[roomState.activePlayerIndex];
      const tm = roomState.turnMarks[activePlayer];
      if (!roomState.turnEndedBy.includes(data.playerName)) {
        roomState.turnEndedBy.push(data.playerName);
      }

      if (
        roomState.turnEndedBy.length === roomState.players.length &&
        !roomState.gameOver
      ) {
        // If active player didn't mark but dice were rolled => penalty
        if (tm.marksCount === 0 && roomState.diceRolledThisTurn) {
          roomState.penalties[activePlayer] =
            (roomState.penalties[activePlayer] || 0) + 1;
        }

        // Lock rows if flagged
        if (roomState.rowsToLock) {
          Object.keys(roomState.rowsToLock).forEach((color) => {
            const whoLocked = roomState.rowsToLock[color];
            if (whoLocked) {
              // lock the row for everyone => no more marking,
              // but only that user gets +1 cross
              roomState.lockedRows[color] = whoLocked;
              roomState.diceActive[color] = false;
            }
          });
          roomState.rowsToLock = {};
        }

        roomState.diceValues = null;

        checkGameOver(currentRoom);
        if (roomState.gameOver) {
          broadcastGameState(currentRoom);
          return;
        }

        // Next player's turn
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

        roomState.turnStartBoards = cloneBoards(roomState.boards);
        roomState.turnStartMarks = cloneTurnMarks(roomState.turnMarks);

        checkGameOver(currentRoom);
      }

      broadcastGameState(currentRoom);
    }

    // Reset Turn for Player
    if (data.type === "resetTurnForPlayer" && currentRoom) {
      const roomState = rooms[currentRoom].gameState;
      if (!roomState.started || roomState.gameOver) {
        sendErrorAndState(
          ws,
          currentRoom,
          "Cannot reset after game is over or not started."
        );
        return;
      }

      if (!roomState.diceRolledThisTurn) {
        sendErrorAndState(ws, currentRoom, "No dice rolled this turn.");
        return;
      }

      const requestingPlayer = data.playerName;
      if (roomState.turnEndedBy.includes(requestingPlayer)) {
        sendErrorAndState(ws, currentRoom, "You already ended your turn.");
        return;
      }

      if (!roomState.turnStartBoards || !roomState.turnStartMarks) {
        sendErrorAndState(ws, currentRoom, "Cannot reset turn state.");
        return;
      }

      // Restore boards/marks from start
      const savedBoard = roomState.turnStartBoards[requestingPlayer];
      if (savedBoard) {
        roomState.boards[requestingPlayer].red = [...savedBoard.red];
        roomState.boards[requestingPlayer].yellow = [...savedBoard.yellow];
        roomState.boards[requestingPlayer].green = [...savedBoard.green];
        roomState.boards[requestingPlayer].blue = [...savedBoard.blue];
      }

      const savedMarks = roomState.turnStartMarks[requestingPlayer];
      if (savedMarks) {
        roomState.turnMarks[requestingPlayer].marksCount =
          savedMarks.marksCount;
        roomState.turnMarks[requestingPlayer].firstMarkWasWhiteSum =
          savedMarks.firstMarkWasWhiteSum;
      }

      broadcastGameState(currentRoom);
    }
  });

  // On Close
  ws.on("close", () => {
    if (currentRoom && playerName) {
      const roomData = rooms[currentRoom];
      if (!roomData) return;
      if (roomData.playersByName[playerName]) {
        roomData.playersByName[playerName].connected = false;
        roomData.clients = roomData.clients.filter((c) => c !== ws);

        console.log(`${playerName} disconnected from room: ${currentRoom}`);
        broadcastGameState(currentRoom);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
