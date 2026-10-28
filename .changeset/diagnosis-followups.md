---
"sandburg": patch
---

Better diagnosis in the ready phase: an app whose page hangs without output (SolidStart streams the page and never ends it on a syntax error or an undeclared import) has its own files checked after 20 s, on a worker thread, and fails as `compile-error` or `undeclared-import` with the file and line instead of timing out after 240 s (an app still compiling its page runs on, and a timeout is classified by what was found); after a cold start's 500, the app's own request to its page's URL answering 500 (a server action's POST) fails the phase fast again; and a console line with a path segment named `Error` followed by a colon is no longer taken for a thrown error.
