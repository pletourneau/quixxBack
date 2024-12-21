const express = require("express");
const WebSocket = require("ws");

const app = express();
const server = require("http").createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Server is running and ready for WebSocket connections!");
});

const rowsConfig = {
  red: { start: 2, end: 12 },
  yellow: { start: 2, end: 12 },
  green: { start: 12, end: 2 },
  blue: { start: 12, end: 2 },
};

function isAscendingRow(color) {
  return color === "red" || color === "yellow";
}

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
    players: roomState.players.map((player) => ({
      name: player.name,
      connected: rooms[room].playersByName[player.name].connected, // ADDED
    })),
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
  // Send to all connected clients
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

      // Check if room exists
      if (!rooms[room]) {
        // Create room
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
            rowsToLock: {},
            turnStartBoards: null,
            turnStartMarks: null,
          },
          clients: [],
          playersByName: {}, // ADDED
          roomCreator: playerName,
        };

        ws.send(JSON.stringify({ type: "newGame", room }));
        console.log(`Room ${room} created by ${playerName}`);
      }

      const roomState = rooms[room].gameState;
      const roomData = rooms[room];

      // Check if game already started
      if (roomState.started) {
        // If started, check if this playerName already exists and is disconnected
        if (roomData.playersByName[playerName]) {
          // Known player
          if (!roomData.playersByName[playerName].connected) {
            // Reconnecting
            roomData.playersByName[playerName].connected = true;
            roomData.playersByName[playerName].ws = ws;

            // Replace in clients list if needed
            roomData.clients.push(ws);
            currentRoom = room;

            console.log(`${playerName} reconnected to room: ${room}`);
            broadcastGameState(room);
          } else {
            // Player already connected from another session?
            // This scenario might be odd - handle as you wish.
            sendErrorAndState(ws, room, "You are already connected.");
          }
        } else {
          // New player trying to join an ongoing game
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

      // ADDED: Track player connection state
      roomData.playersByName[playerName] = {
        ws,
        connected: true,
      };

      roomData.clients.push(ws);
      currentRoom = room;

      console.log(`${playerName} joined room: ${room}`);
      broadcastGameState(room);
    }

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
        sendErrorAndState(
          ws,
          currentRoom,
          "Only the room creator can start the game."
        );
      }
    }

    if (data.type === "rollDice" && currentRoom) {
      const roomState = rooms[currentRoom].gameState;
      if (roomState.gameOver) {
        sendErrorAndState(ws, currentRoom, "Game is over.");
        return;
      }

      const activePlayer = roomState.turnOrder[roomState.activePlayerIndex];
      if (activePlayer === playerName) {
        if (roomState.diceRolledThisTurn) {
          sendErrorAndState(
            ws,
            currentRoom,
            "Dice have already been rolled this turn."
          );
          return;
        }

        function rollDie() {
          return Math.floor(Math.random() * 6) + 1;
        }
        let diceValues = { white1: rollDie(), white2: rollDie() };
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
        sendErrorAndState(ws, currentRoom, "You are not the active player.");
      }
    }

    if (data.type === "markCell" && currentRoom) {
      const roomState = rooms[currentRoom].gameState;
      if (roomState.gameOver) {
        sendErrorAndState(ws, currentRoom, "Game is over.");
        return;
      }

      const { playerName: markPlayerName, color, number } = data;

      if (!roomState.diceRolledThisTurn) {
        sendErrorAndState(
          ws,
          currentRoom,
          "You cannot mark before dice are rolled this turn."
        );
        return;
      }

      if (!roomState.boards[markPlayerName]) {
        sendErrorAndState(ws, currentRoom, "Player board not found.");
        return;
      }

      if (roomState.lockedRows[color]) {
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
        sendErrorAndState(ws, currentRoom, "No dice values rolled this turn.");
        return;
      }

      const whiteSum =
        roomState.diceValues.white1 + roomState.diceValues.white2;
      let validSums = [whiteSum];
      let sumToColors = {};
      sumToColors[whiteSum] = ["white"];

      function addColorSum(num, ccolor) {
        if (!sumToColors[num]) sumToColors[num] = [];
        if (!sumToColors[num].includes(ccolor)) sumToColors[num].push(ccolor);
      }

      function addIfActive(cc, val1, val2) {
        if (roomState.diceActive[cc]) {
          validSums.push(val1, val2);
          addColorSum(val1, cc);
          addColorSum(val2, cc);
        }
      }

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

      if (!validSums.includes(number)) {
        sendErrorAndState(
          ws,
          currentRoom,
          "Chosen cell does not match any allowed sums."
        );
        return;
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
            ws,
            currentRoom,
            "Cannot mark a smaller number than one already marked."
          );
          return;
        }
        if (!isAscendingRow(color) && number > minMarked) {
          sendErrorAndState(
            ws,
            currentRoom,
            "Cannot mark a larger number than one already marked."
          );
          return;
        }
      }

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
          sendErrorAndState(
            ws,
            currentRoom,
            "Non-active player must mark the white dice sum."
          );
          return;
        }
      } else {
        if (tm.marksCount === 0) {
          tm.firstMarkWasWhiteSum = number === whiteSum;
        } else if (tm.marksCount === 1) {
          if (!tm.firstMarkWasWhiteSum) {
            sendErrorAndState(
              ws,
              currentRoom,
              "To make a second mark, the first must be the white dice sum."
            );
            return;
          }
          const possibleColors = sumToColors[number];
          const hasColor =
            possibleColors && possibleColors.some((c) => c !== "white");
          if (!hasColor) {
            sendErrorAndState(
              ws,
              currentRoom,
              "Second mark must be from a white+color combination."
            );
            return;
          }
        } else {
          sendErrorAndState(
            ws,
            currentRoom,
            "You have already marked two numbers this turn."
          );
          return;
        }
      }

      let finalNumber = isAscendingRow(color) ? 12 : 2;
      if (number === finalNumber) {
        const marksInRow = rowArray.filter((x) => x).length;
        if (marksInRow < 5) {
          sendErrorAndState(
            ws,
            currentRoom,
            "You must have at least 5 marks before marking the final number."
          );
          return;
        }

        roomState.rowsToLock[color] = true;
      }

      rowArray[index] = true;
      tm.marksCount += 1;
      roomState.turnMarks[markPlayerName] = tm;

      broadcastGameState(currentRoom);
    }

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
        if (tm.marksCount === 0 && roomState.diceRolledThisTurn) {
          roomState.penalties[activePlayer] =
            (roomState.penalties[activePlayer] || 0) + 1;
        }

        if (roomState.rowsToLock) {
          Object.keys(roomState.rowsToLock).forEach((color) => {
            if (roomState.rowsToLock[color]) {
              roomState.lockedRows[color] = true;
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
        sendErrorAndState(
          ws,
          currentRoom,
          "No dice rolled this turn, nothing to reset."
        );
        return;
      }

      const requestingPlayer = data.playerName;
      if (roomState.turnEndedBy.includes(requestingPlayer)) {
        sendErrorAndState(
          ws,
          currentRoom,
          "You have already ended your turn and cannot reset."
        );
        return;
      }

      if (!roomState.turnStartBoards || !roomState.turnStartMarks) {
        sendErrorAndState(ws, currentRoom, "Cannot reset turn state.");
        return;
      }

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

  ws.on("close", () => {
    if (currentRoom && playerName) {
      const roomData = rooms[currentRoom];
      if (!roomData) return;
      // Instead of removing the player, mark them as disconnected
      if (roomData.playersByName[playerName]) {
        roomData.playersByName[playerName].connected = false;
        // Remove the ws from the clients list
        roomData.clients = roomData.clients.filter((c) => c !== ws);

        console.log(`${playerName} disconnected from room: ${currentRoom}`);
        // We do not remove them from the turnOrder or players array
        // The game can continue and they can potentially reconnect.

        // Broadcast updated state so others see that this player is disconnected
        broadcastGameState(currentRoom);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
