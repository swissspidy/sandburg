---
"sandburg": patch
---

Better diagnosis in the ready phase: an app whose page stalls without output (SolidStart on a syntax error or an undeclared import) has its own sources checked after 20 s and fails as `compile-error` or `undeclared-import` with the file and line, instead of timing out after 240 s; after a cold start's 500, the app's own request to its page's URL answering 500 (a server action's POST) fails the phase fast again; and a console line with a path segment named `Error` followed by a colon is no longer taken for a thrown error.
