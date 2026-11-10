---
"sandburg": patch
---

Fixes found by reading the whole project:

- A dev script whose runner takes a flag with a value (`node -r dotenv/config server.js`, `node --env-file .env server.js`, `nodemon --watch src src/index.js`, `tsx watch --tsconfig tsconfig.server.json server.ts`) starts its entry file. Before, the flag's value was taken for the file.
- `sandburg run <a workspace package> --save-files` writes the files where the app has them, in the monorepo. Before, they went to a second copy of the package's path inside the package.
- `sandburg compare`'s Docker reference runs Angular projects that have a `start` script and no `dev` script, as the Angular CLI makes them. Before, it called them unsupported.
- A batch finds the earlier runs of a monorepo's packages, for its order and its memory guard: a summary names a run by the path its item gave.
- An install that fails removes its temporary directory in `.sandburg/installs`. Before, each failed install left one for good.
- A dev script that runs a program no installed package provides is the app's failure (`adapter-code:APP`) with a host install too, as with an install in the browser.
