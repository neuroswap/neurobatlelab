const WebSocket = require("ws");

const wss = new WebSocket.Server({ port: 3000 });

let players = {};

wss.on("connection", (ws) => {
    const id = Math.random().toString(36).substring(2);
    
    players[id] = {
        x: 0,
        y: 0,
        z: 0
    };

    ws.send(JSON.stringify({ type: "init", id, players }));

    ws.on("message", (msg) => {
        const data = JSON.parse(msg);

        if (data.type === "move") {
            players[id] = data.position;

            // broadcast updates
            wss.clients.forEach(client => {
                if (client.readyState === 1) {
                    client.send(JSON.stringify({
                        type: "update",
                        players
                    }));
                }
            });
        }
    });

    ws.on("close", () => {
        delete players[id];
    });
});

console.log("Server running on ws://localhost:3000");
