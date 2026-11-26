# Embedding the browser runtime

Sandburg's Node.js runtime can run a project in any page, without the Sandburg CLI, a Node.js process
or Playwright: the project's dev server and the app run in the visitor's browser, packages install
from the npm registry in the page, and modules compile in the page. The package ships it prebuilt as
`sandburg/browser-runtime` ([ADR 0074](../adr/0074-browser-runtime-export.md)). The demo site's
generator page runs on the same files.

```sh
npm install sandburg   # Playwright is not needed for this
```

## Serve the directory

Serve `node_modules/sandburg/dist/browser-runtime/` as static files, for example at `/sandburg/`. In
Node.js, find it with:

```js
const dir = new URL('./', import.meta.resolve('sandburg/browser-runtime/sw.js'));
```

- The page must be a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts):
  HTTPS, or `http://localhost`. Service workers and the runtime's shared memory need one.
- The runtime's service worker controls the embedding page. Its scope is the page's path; when that
  is not under the runtime's directory (a page at `/play/`, the runtime at `/sandburg/`), serve
  `sw.js` with `Service-Worker-Allowed: /play/` (or `/`).
- The service worker gives the page the headers that make it cross-origin isolated
  (`Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy`), after one reload. A server that sets
  them itself saves the reload.

The API's declarations, with every type, are in
[`api/sandburg-browser-runtime.api.md`](../../api/sandburg-browser-runtime.api.md).

## Run a project

The page needs an `<iframe id="app">`: the runtime loads the app into it.

```html
<iframe id="app"></iframe>
<script type="module">
  import { isolate, loadHost, startProject, appPath, guardAppFrame } from '/sandburg/index.js';

  const options = { base: '/sandburg/', scope: '/play/', pass: ['/play/assets/'] };
  if (await isolate(options)) {
    const host = await loadHost(options);
    guardAppFrame(document.getElementById('app'), appPath(options));
    const { url } = await startProject(host, {
      'package.json': JSON.stringify({ scripts: { dev: 'node server.js' } }),
      'server.js': "require('node:http').createServer((q, s) => s.end('hello')).listen(3000);",
    }, options);
  }
</script>
```

| Export | What it does |
|---|---|
| `isolate(options?)` | Registers the service worker and reloads the page once, for cross-origin isolation. `true` when the page is isolated; `false` while it reloads (do nothing more). Rejects with what is wrong when the reload did not help. |
| `loadHost(options?)` | Loads the runtime's host (`host.js`) and returns its API (`HostApi`: `mount`, `install`, `start`, `ready`, `dispose`, …), the one a Sandburg run drives. |
| `startProject(host, files, options?)` | Ends the host's previous project, then mounts the files, installs the packages, starts the dev server (or `npm start`) and loads the app into the frame. Resolves to `{ url, install }`; rejects with the failing phase's error. |
| `appPath(options?)` | The path the app lives at (`options.app`). |
| `guardAppFrame(frame, appPath, onAddress?)` | Keeps the app frame under the app's path when the app reloads itself, and reports its address. |
| `isolationFailure()` | Why the page is not cross-origin isolated, worded for a visitor. |
| `detectFramework(files, packageJson)`, `pageInstall(project)` | What `startProject` uses, for pages that drive the host themselves. |

`options` (`EmbedOptions`):

| Option | Default | What it is |
|---|---|---|
| `base` | where `index.js` was loaded from | Where the runtime's directory is served. |
| `scope` | the page's directory | The service worker's scope: a path that holds the embedding page. |
| `app` | `<scope>app` | The path the app lives at. The app sees itself at `/`: a link or redirect to a path that starts with this one is taken to be under it already (an app that writes deployment paths), so pick a path the app's own routes do not start with. |
| `pass` | — | Path prefixes under the scope that are the embedder's own files (scripts, styles), left to the network. The runtime's directory always is. Other paths outside the app are taken to be the app's own absolute paths (`/_next/…`, `/src/main.tsx`). |

## What it does not do

- **No network controls.** A Sandburg run sends the app's requests through its egress gateway, with
  an allowlist ([Security](security.md)). An embedded runtime has none: the app's requests are the
  browser's.
- **The app runs on the page's origin.** Whatever the embedding page can read (its storage, its
  cookies), the app can too. The generator page keeps its API key in a sandboxed frame for this reason
  ([ADR 0021](../adr/0021-generate-in-the-browser.md)).
- **No checks or results.** Checks, the network check, classification and `result.json` are the
  CLI's and the library's, which need Playwright.
- **No host caches.** A Sandburg host keeps installs, compiled modules and dev-server caches between
  runs. An embedded runtime installs and compiles again on each page load.
