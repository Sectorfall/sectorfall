import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 2096 });

console.log("Sectorfall realtime server running on port 2096");

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

