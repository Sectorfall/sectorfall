import http from 'http';
import { WebSocketServer } from 'ws';

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Sectorfall WebSocket Server");
});

const wss = new WebSocketServer({ server });

wss.on('connection', (socket) => {
  console.log('Player connected');

  socket.on('message', (msg) => {
    console.log('Received:', msg.toString());
    socket.send("Server received: " + msg);
  });

  socket.on('close', () => {
    console.log('Player disconnected');
  });
});

server.listen(2096, () => {
  console.log("Sectorfall realtime server running on port 2096");
});