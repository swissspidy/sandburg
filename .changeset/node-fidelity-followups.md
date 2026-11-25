---
'sandburg': patch
---

Closer to Node and to the developer's machine:

- A server's own `fetch()` of a localhost URL (`fetch('http://localhost:3000/api')` in server code) no longer sends the page's cookies, and the cookies it is answered with no longer reach the browser, as with Node's `fetch()`. The page's own requests send and receive cookies as before.
- A script, font or image the page loads from another localhost port (`<script type="module" src="http://localhost:3001/…">`) is subject to that server's CORS headers, as it is in a browser on the developer's machine: it loads only when its `Access-Control-Allow-Origin` (and, with credentials, `Access-Control-Allow-Credentials`) allows the page. The page's own port and a server's `fetch()` are not checked, as before.
- `require.main` is `undefined` for a program given as text (`node -e`, `node -p`, `node -` reading stdin, a worker's `eval`), as in Node.
