import { io } from 'socket.io-client';

interface Message {
  text: string;
  at: number;
}

const socket = io();
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const list = document.querySelector<HTMLUListElement>('#messages')!;
const form = document.querySelector<HTMLFormElement>('#form')!;
const input = document.querySelector<HTMLInputElement>('#text')!;

const show = (m: Message) => {
  const li = document.createElement('li');
  li.textContent = m.text;
  list.append(li);
};

socket.on('connect', () => {
  status.textContent = `connected via ${socket.io.engine.transport.name}`;
  socket.io.engine.on('upgrade', (t: { name: string }) => (status.textContent = `connected via ${t.name}`));
});
socket.on('history', (messages: Message[]) => messages.forEach(show));
socket.on('message', show);

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!input.value) return;
  socket.emit('say', input.value);
  input.value = '';
});
