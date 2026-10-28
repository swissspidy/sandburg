---
"sandburg": patch
---

Better diagnosis in the ready phase: a ready phase that times out (SolidStart streams the page and never ends it on a syntax error or an undeclared import, and says nothing) is classified as `compile-error` or `undeclared-import` with the file and line, from a check of the files the app read, made in a process of its own when the app has not rendered after 20 s; the check never fails a run early; after a cold start's 500, the app's own request to its page's URL answering 500 (a server action's POST) fails the phase fast again; and a console line with a path segment named `Error` followed by a colon is no longer taken for a thrown error.
