---
'sandburg': patch
---

An unref'd worker thread no longer keeps its process alive, as in Node: a short-lived CLI that loads a napi-rs WebAssembly package (the Tailwind CLI's `@tailwindcss/oxide`, `svelte-kit sync`'s rolldown), which unrefs its idle threads, exits once its work is done, and the dev script's next command runs. A `MessagePort` the program `ref()`s keeps its process alive until it is unref'd or closed, which is how emnapi keeps it alive while async work runs on those threads.
