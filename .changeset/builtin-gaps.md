---
'sandburg': patch
---

Built-in modules have more of what Node 24 has: `events.on`, `errorMonitor`, `captureRejections` (as a constructor option, a static and `Symbol.for('nodejs.rejection')`) and `getMaxListeners`/`setMaxListeners`; `process.getBuiltinModule`; a real `punycode` (it returned its input unchanged); `util.types.isKeyObject`, `isCryptoKey` and `isFloat16Array`; `fs.fchmod`, `fchown` and `lchown`; `os.constants.errno`, `priority` and `dlopen`, all of `fs.constants`, and `require('constants')` as Node assembles it; `querystring.escape`, `unescape` and `unescapeBuffer`; `stream.isDestroyed`, `isWritable` and `duplexPair`; `vm.createScript`; `url.URLPattern`. `test`, `sqlite` and `sea` are built-ins only with `node:`, as in Node: `require('sqlite')` loads the npm package.
