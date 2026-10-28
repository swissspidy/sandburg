// A pnpm workspace whose app is its root: a workspace:* package, a link: package, and versions
// pinned by pnpm-lock.yaml (ms ^2.0.0 is locked to 2.0.0, escape-html ^1.0.0 to 1.0.2).
const http = require('node:http');
const util = require('@acme/util');
const { label } = require('local-lib');

const port = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html lang="en"><title>pnpm</title><main><h1>${util.escape(`<${label}>`)}</h1><p id="ms">ms ${require('ms/package.json').version}</p><p id="escape">escape-html ${util.escapeVersion}</p></main></html>`);
  })
  .listen(port, () => console.log(`listening on ${port}`));
