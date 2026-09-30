import { createServer } from 'node:http';
import express from 'express';
import { Server } from 'socket.io';

const app = express();
const server = createServer(app);
const io = new Server(server);
const history = [];

io.on('connection', (socket) => {
  socket.emit('history', history);
  socket.on('say', (text) => {
    const message = { text: String(text).slice(0, 200), at: history.length + 1 };
    history.push(message);
    io.emit('message', message);
  });
});

server.listen(3001, () => console.log('chat server on :3001'));
