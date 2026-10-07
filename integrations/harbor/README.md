# Sandburg as a Harbor environment

[Harbor](https://harborframework.com) runs an agent on a task, then a verifier, in an
environment, usually a Docker container. This directory lets Harbor run without containers:

- **The agent runs on this machine**, in a per-trial directory, like any CLI coding agent.
- **The app it builds runs in Sandburg**: packages installed and code run in a browser tab
  (`sandburg run`). The agent calls `sandburg run .` to see whether the app works; the verifier
  runs the app the same way with the task's checks.

The untrusted part of an app-building task is the app: the packages it installs, its dev
server, the code the agent wrote. That is what runs in Sandburg. The agent's own process is not
sandboxed. Limit what it may run with its own permissions (below).

## Running a task

```sh
uv venv --python 3.12 .venv && VIRTUAL_ENV=.venv uv pip install harbor
node integrations/harbor/build-tasks.ts --tasks todo --stacks vanilla,react \
  [--solutions .sandburg/evals/<run>]

# Plumbing check: the oracle copies a known-good app (from --solutions) over the scaffold.
PYTHONPATH=integrations/harbor .venv/bin/harbor run -p integrations/harbor/tasks/todo-vanilla \
  -a oracle -e sandburg_harbor:SandburgEnvironment

# Claude Code, allowed to read and edit files and to run `sandburg`, nothing else.
ANTHROPIC_API_KEY=… PYTHONPATH=integrations/harbor .venv/bin/harbor run \
  -p integrations/harbor/tasks/todo-react -a claude-code -m anthropic/claude-opus-5-5 \
  --ak permission_mode=dontAsk --ak "allowed_tools=Read,Edit,Write,Glob,Grep,Bash(sandburg:*)" \
  -e sandburg_harbor:SandburgEnvironment
```

`claude` must be on `PATH` (Harbor then skips installing it). With `permission_mode=dontAsk`,
Claude Code refuses every tool call that `allowed_tools` does not allow, so it cannot run `npm`,
`node` or the app's code on this machine.

## Tasks

`build-tasks.ts` writes one task per app-gen eval task × stack ([`evals/app-gen`](../../evals/app-gen)):

- `instruction.md`: what the generator page tells its model about the runtime, how to run the
  app with `sandburg run`, and the eval's request.
- `environment/`: the stack's scaffold, copied into `/app` when the trial starts.
- `tests/`: `test.sh` runs `sandburg run . --install-in browser` with the eval's checks
  (`checks.ts` loads them from `evals/app-gen/suite.ts`), and `reward.mjs` writes
  `reward.json`: `score` (the share of checks that passed) and `passed` (1 if all did).
- `solution/` (with `--solutions`): a passing app from an eval run, for `-a oracle`.

The eval's follow-up requests are not tasks yet. They would be a second step of a multi-step task
that keeps `/app`, and its SQLite file, from the first.

## How the environment works

[`sandburg_harbor/environment.py`](sandburg_harbor/environment.py) implements Harbor's
`BaseEnvironment`: `start`, `stop`, `exec`, and file upload and download.

Harbor addresses an environment through fixed absolute paths: the task's workdir (`/app`),
`/tests`, `/solution` and `/logs/…`. They are constants in Harbor and in its agents, and on macOS
a process cannot be given its own view of the file system. So each trial gets a root directory,
and the environment maps those paths into it: in the commands it runs, their working directory and
environment variables, the scripts uploaded to `/tests` and `/solution`, and uploads and
downloads. Only whole paths are mapped (`/app` and `/app/…`, not `/application`). `/logs/agent`,
`/logs/verifier` and `/logs/artifacts` are the trial's own log folders, so Harbor reads them in
place.

Commands run with `bash -c`, as the current user, with a `sandburg` command on `PATH`. That
command installs an app's packages in the browser unless `--install-in` says otherwise.

Known gaps:

- Harbor looks for Claude Code's session under `projects/-app`, a name Claude Code derives from
  its working directory. Here that is the trial's directory, so Harbor's trajectory view of the
  run is missing; the run itself and its log (`agent/claude-code.txt`) are not affected.
- A path the agent's own tools use inside its process (not in a command Harbor runs) is not
  mapped. The instructions talk about the current directory, not `/app`.
- Network policies and resource limits are not enforced.
