---
'sandburg': patch
---

A project's SQLite database in WAL mode opens with `better-sqlite3`, `sqlite3` and `node:sqlite` instead of failing with `SQLITE_CANTOPEN`, with the transactions still in its `-wal` file, as SQLite reads the pair. It is written back in WAL mode, its `-wal` and `-shm` emptied, as after SQLite's own checkpoint.

`node:stream/web` has the readers, writers and controllers Node's has (`ReadableStreamBYOBReader`, `ReadableStreamDefaultReader`, `WritableStreamDefaultWriter` and the rest): Next.js's Edge Runtime primitives, which re-export them, load.
