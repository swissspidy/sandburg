---
'sandburg': patch
---

node:crypto has `scrypt` and `scryptSync`, as Node derives them: an app that hashes passwords with them no longer fails to start with "scryptSync is not a function".
