---
'sandburg': patch
---

In a project with top-level `await`, ES modules that import each other (a cycle, as `@remix-run/route-pattern`'s, which `react-router` 8 loads) no longer fail with "Cannot access '__sandburg_tla' before initialization": a module reached again while it is still evaluating its imports is not waited for, as in Node.
