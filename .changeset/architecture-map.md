---
"sandburg": patch
---

The codebase's architecture is written down and checked: docs/architecture.md maps where each module runs, what may import what and the contracts between the parts, and a test fails on a browser module that imports Node's modules, a lower layer that imports a higher one, or a new import cycle. Each framework's knowledge is one entry of a table (src/framework.ts). Fixes a runtime's read report of long paths closing its file channel (later files then came over slower HTTP), and the browser installer (`--install-in browser`) now refuses dependency specs by the host installer's rule.
