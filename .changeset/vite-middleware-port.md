---
'sandburg': patch
---

An Express server that embeds Vite in middleware mode (`createServer({ server: { middlewareMode: true } })`, run as `node server.js`) is the app: Vite's HMR WebSocket server, which listens first on 24678, is no longer taken for it, as a server that answers a plain request with 426 Upgrade Required. `http.STATUS_CODES` has all of Node's codes (426 among them, which `ws` needs).
