const WebSocket = require("ws");
const { Chess } = require("chess.js");

// Game class to manage individual chess games
class ChessGame {
  constructor(gameId) {
    this.gameId = gameId;
    this.chess = new Chess();
    this.players = []; // Array to store WebSocket connections of players
    this.createdAt = Date.now();
  }

  addPlayer(ws, color) {
    // Store game info on the WebSocket connection itself for easy access later
    ws.gameId = this.gameId;
    ws.color = color;
    this.players.push(ws);
  }

  isFull() {
    return this.players.length >= 2;
  }

  makeMove(move) {
    return this.chess.move(move);
  }

  // Send a message to all players in this game
  broadcast(message) {
    const data = JSON.stringify(message);
    this.players.forEach(player => {
      // Check if WebSocket connection is still open before sending
      if (player.readyState === WebSocket.OPEN) {
        player.send(data); // Send JSON string over WebSocket
      }
    });
  }

  getState() {
    return {
      fen: this.chess.fen(),
      turn: this.chess.turn(),
      isGameOver: this.chess.isGameOver(),
      isCheck: this.chess.isCheck(),
      isCheckmate: this.chess.isCheckmate(),
      isDraw: this.chess.isDraw()
    };
  }

  removePlayer(ws) {
    this.players = this.players.filter(p => p !== ws);
  }

  isEmpty() {
    return this.players.length === 0;
  }
}

// GameManager class to handle multiple games
class GameManager {
  constructor() {
    this.games = new Map(); // Map stores key-value pairs: gameId -> ChessGame object
  }

  createGame() {
    const gameId = this.generateGameId();
    const game = new ChessGame(gameId);
    this.games.set(gameId, game); // Store the new game
    return game;
  }

  getGame(gameId) {
    return this.games.get(gameId); // Retrieve game by ID
  }

  deleteGame(gameId) {
    this.games.delete(gameId); // Remove game from storage
  }

  generateGameId() {
    let gameId;
    // Keep generating until we get a unique ID
    do {
      gameId = Math.random().toString(36).substr(2, 6).toUpperCase();
    } while (this.games.has(gameId));
    return gameId;
  }

  getActiveGamesCount() {
    return this.games.size;
  }

  cleanupEmptyGames() {
    for (const [gameId, game] of this.games.entries()) {
      if (game.isEmpty()) {
        this.deleteGame(gameId);
      }
    }
  }
}

// Main server class
class ChessServer {
  constructor(port = 8080) {
    // Create WebSocket server that listens on specified port
    this.wss = new WebSocket.Server({ port });
    this.gameManager = new GameManager();
    this.setupServer();
  }

  setupServer() {
    // This event fires whenever a client connects to the WebSocket server
    this.wss.on("connection", (ws) => {
      console.log("New client connected");

      // Listen for messages from this client
      // 'message' event fires when client sends data to server
      ws.on("message", (message) => {
        try {
          const data = JSON.parse(message); // Convert JSON string to object
          this.handleMessage(ws, data);
        } catch (error) {
          console.error("Error processing message:", error);
          // Send error back to client as JSON string
          ws.send(JSON.stringify({ type: "ERROR", message: "Invalid message format" }));
        }
      });

      // 'close' event fires when client disconnects
      ws.on("close", () => {
        this.handleDisconnect(ws);
      });

      // 'error' event fires on WebSocket errors
      ws.on("error", (error) => {
        console.error("WebSocket error:", error);
      });
    });

    console.log(`Chess server running on ws://localhost:${this.wss.options.port}`);
  }

  // Route incoming messages based on their type
  handleMessage(ws, data) {
    switch (data.type) {
      case "CREATE_GAME":
        this.handleCreateGame(ws);
        break;

      case "JOIN_GAME":
        this.handleJoinGame(ws, data.gameId);
        break;

      case "MOVE":
        this.handleMove(ws, data);
        break;

      case "GET_STATE":
        this.handleGetState(ws);
        break;

      default:
        ws.send(JSON.stringify({ type: "ERROR", message: "Unknown message type" }));
    }
  }

  handleCreateGame(ws) {
    const game = this.gameManager.createGame();
    game.addPlayer(ws, "white"); // First player is always white

    // Send response back to client via WebSocket
    ws.send(JSON.stringify({
      type: "GAME_CREATED",
      gameId: game.gameId,
      color: "white",
      state: game.getState()
    }));

    console.log(`Game ${game.gameId} created. Active games: ${this.gameManager.getActiveGamesCount()}`);
  }

  handleJoinGame(ws, gameId) {
    const game = this.gameManager.getGame(gameId);

    if (!game) {
      // Send error message if game doesn't exist
      ws.send(JSON.stringify({ type: "ERROR", message: "Game not found" }));
      return;
    }

    if (game.isFull()) {
      ws.send(JSON.stringify({ type: "ERROR", message: "Game is full" }));
      return;
    }

    game.addPlayer(ws, "black"); // Second player is black

    // Notify BOTH players that game is starting
    game.broadcast({
      type: "GAME_START",
      state: game.getState()
    });

    console.log(`Player joined game ${game.gameId}`);
  }

  handleMove(ws, data) {
    const game = this.gameManager.getGame(ws.gameId);

    if (!game) {
      ws.send(JSON.stringify({ type: "ERROR", message: "Game not found" }));
      return;
    }

    // Verify it's the player's turn
    const currentTurn = game.chess.turn() === 'w' ? 'white' : 'black';
    if (ws.color !== currentTurn) {
      ws.send(JSON.stringify({ type: "ERROR", message: "Not your turn" }));
      return;
    }

    const move = game.makeMove(data.move);

    if (!move) {
      // Invalid move (chess.js rejected it)
      ws.send(JSON.stringify({ type: "ERROR", message: "Invalid move" }));
      return;
    }

    // Send the move to both players
    game.broadcast({
      type: "MOVE",
      move,
      state: game.getState()
    });

    // Check if game is over
    if (game.chess.isGameOver()) {
      let result;
      if (game.chess.isCheckmate()) {
        result = game.chess.turn() === 'w' ? 'black' : 'white';
      } else {
        result = 'draw';
      }

      game.broadcast({
        type: "GAME_OVER",
        result,
        reason: game.chess.isCheckmate() ? 'checkmate' : 
                game.chess.isDraw() ? 'draw' : 'stalemate'
      });
    }
  }

  handleGetState(ws) {
    const game = this.gameManager.getGame(ws.gameId);

    if (!game) {
      ws.send(JSON.stringify({ type: "ERROR", message: "Game not found" }));
      return;
    }

    ws.send(JSON.stringify({
      type: "STATE",
      state: game.getState()
    }));
  }

  handleDisconnect(ws) {
    if (ws.gameId) {
      const game = this.gameManager.getGame(ws.gameId);
      if (game) {
        game.removePlayer(ws);
        
        // Tell the other player that their opponent left
        game.broadcast({
          type: "PLAYER_DISCONNECTED",
          message: "Opponent disconnected"
        });

        // If no players left, delete the game to free memory
        if (game.isEmpty()) {
          this.gameManager.deleteGame(ws.gameId);
          console.log(`Game ${ws.gameId} deleted. Active games: ${this.gameManager.getActiveGamesCount()}`);
        }
      }
    }
    console.log("Client disconnected");
  }
}

// Start the server
const server = new ChessServer(8080);