const WebSocket = require("ws");

const wss = new WebSocket.Server({ port: 3000 });

let players = {};

wss.on("connection", (ws) => {
  const id = Math.random().toString(36).substr(2);

  players[id] = { x: 0, y: 0, z: 0 };

  ws.on("message", (msg) => {
    const data = JSON.parse(msg);
    players[id] = data;
  });

  setInterval(() => {
    ws.send(JSON.stringify(players));
  }, 50);
});
