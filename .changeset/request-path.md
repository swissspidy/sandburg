---
"sandburg": patch
---

Faster app requests through the service worker: a response the app's server ends in one go reaches the service worker in one message instead of a start, chunks and an end, every request shares one port to the host page instead of a channel of its own, and the WebSocket shim each app page loads first is answered from the service worker's memory.
