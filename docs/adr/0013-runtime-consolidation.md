# ADR 0013: One Node.js runtime, `--runtime auto`, almostnode and Nodebox removed

- Status: Accepted
- Date: 2026-09-30
- Supersedes: [ADR 0003](0003-nextjs-and-nodebox.md). Amends [ADR 0001](0001-runtime-adapters-serving-results.md): almostnode is no longer the default.

## Context

Sandburg had six runtimes. Two of them ran JavaScript servers in the browser
without being Node.js:

- **almostnode** (the default until now) rendered Next.js pages in the
  browser and loaded packages from esm.sh, not from the project's lockfile.
  The adapter had to patch it to work at all (ADR 0003): a hard-coded
  React 18, a hang with React 19's document elements, and a `next/server`
  shim. It could not run server-only code: databases, `fs`, server
  components that read data, cookies, route handlers beyond the shim. Its one
  strength was speed, 2–3 s for a small app.
- **Nodebox** emulated Node.js 16 and rejected every current stack up front.
  It is non-commercial (Sustainable Use License) and can only be loaded from
  CodeSandbox's servers.

Meanwhile our own node runtime (ADR 0006) runs the real tools: `next dev`,
Vite 8 with every meta-framework we tried (ADR 0012), Express with SQLite.
It installs the project's own dependencies with npm. The esbuild adapter
(ADR 0007) is the fast path for client-side Vite apps: 3–10 s, with the
app's own compilers.

## Decision

- **Remove almostnode and Nodebox** with their adapters, shims, dependency
  and tests.
- **`--runtime auto` is the default.** It picks the runtime per project:

  | Project | Runtime |
  |---|---|
  | WordPress plugin or theme | `wordpress` |
  | Angular CLI app | `angular` |
  | Anything the esbuild build supports: client-side Vite apps, static sites, and those with a Node backend | `esbuild` |
  | Everything else: Next.js, SvelteKit, Astro, Nuxt, React Router, SolidStart, Vite with other plugins or PostCSS, Node servers | `node` |

  The esbuild probe decides the third row, so a Vite app with a plugin
  esbuild cannot apply runs on real Vite instead of being rejected. A run
  records the concrete runtime it used. `--runtime <name>` still forces
  one.
- **Classification** loses the almostnode-specific rules: the esm.sh
  signature, and the `/__virtual__/` check for project stack frames (now
  any served project file). An import of a package the project never
  declared is an app bug, whether the browser, esbuild, Vite or Node
  reports it. Node built-ins are excluded.

## Consequences

- Fewer runtimes to keep working. `auto` removes the need to know which
  one a project needs.
- Next.js runs are real `next dev` runs, which are slower: 20–60 s instead of
  2–3 s. They now catch what almostnode could not, such as server-only code
  and cookies.
- The fidelity studies v1 and v2 measured almostnode. They stay as history.
  Study v3 below measures `auto` against the corpus's ground truth. Docker was
  not available for it, so it has no agreement figure. Rerun
  `sandburg compare` where Docker is available.
- Offline runs no longer need esm.sh in the cache: every runtime installs
  from the npm registry on the host.

## Study v3: `--runtime auto` vs ground truth

Running; results will be added here.
