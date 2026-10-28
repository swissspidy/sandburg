// The app of an npm workspaces monorepo: it imports a workspace package (@acme/greet, which has a
// registry dependency of its own) and a local package outside the workspaces (file:).
const http = require('node:http');
const { shout } = require('@acme/format');

const port = process.env.PORT || 3000;
http
  .createServer(async (req, res) => {
    const { greet, msVersion, ms } = await import('@acme/greet');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html lang="en"><title>Monorepo</title><main><h1>${shout(greet('monorepo'))}</h1><p id="ms">ms ${msVersion}</p><p id="copies">${ms === require('ms') ? 'one ms' : 'two copies of ms'}</p></main></html>`);
  })
  .listen(port, () => console.log(`listening on ${port}`));
