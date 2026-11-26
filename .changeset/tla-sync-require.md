---
'sandburg': patch
---

In a project with top-level `await`, an ES module that awaits nothing itself is evaluated at once when nothing it imports is still evaluating, as in Node. A CommonJS package that `require()`s one synchronously gets it evaluated: Vite 8 loaded with `await import('vite')` no longer fails with rolldown's "Cannot find native binding" (its binding requires `@emnapi/core`, a pure ES module, that way).
