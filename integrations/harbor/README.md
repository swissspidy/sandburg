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

# Claude Code: it may edit the project's files and run `sandburg`, and read nothing outside it.
ANTHROPIC_API_KEY=… PYTHONPATH=integrations/harbor .venv/bin/harbor run \
  -p integrations/harbor/tasks/todo-react -a claude-code -m anthropic/claude-opus-5-5 \
  --ak permission_mode=dontAsk --ak "allowed_tools=Read,Edit,Write,Glob,Grep,Bash(sandburg:*)" \
  --ak config=integrations/harbor/claude-settings.json \
  -e sandburg_harbor:SandburgEnvironment
```

`claude` must be on `PATH` (Harbor then skips installing it). What the agent may do:

- `permission_mode=dontAsk` refuses every tool call that `allowed_tools` does not allow: it
  cannot run `npm`, `node` or the app's code on this machine, only `sandburg`.
- Claude Code still runs its built-in read-only commands (`ls`, `cat`, `find`, `grep`, …)
  without asking, in every mode. [`claude-settings.json`](claude-settings.json) sets
  `permissions.blockReadsOutsideWorkingDirectories`, which fences those and the file tools to the
  trial's directory.
- For an OS-level fence on its shell commands as well, add Claude Code's sandbox to the settings
  (`"sandbox": {"enabled": true, "excludedCommands": ["sandburg *"]}`; Seatbelt on macOS,
  bubblewrap on Linux). `sandburg` has to run outside it: it starts Chromium. Not tried here.

## Tasks

`build-tasks.ts` writes one task per app-gen eval task × stack ([`evals/app-gen`](../../evals/app-gen)):

- `instruction.md`: what the generator page tells its model about the runtime, how to run the
  app with `sandburg run`, and the eval's request.
- `environment/`: the stack's scaffold, copied into `/app` when the trial starts.
- `tests/`: `test.sh` runs `sandburg run . --install-in browser` with the eval's checks
  (`checks.ts` loads them from `evals/app-gen/suite.ts`), and `reward.mjs` writes
  `reward.json`: `score` (the share of checks that passed) and `passed` (1 if all did).
- `solution/` (with `--solutions`): a passing app from an eval run, for `-a oracle`.

Every eval task also has a follow-up request ("add a priority to tasks"), so the tasks have
[two steps](https://harborframework.com/docs/tasks/multi-step), under `steps/`:

1. `request`: the request above, from the scaffold.
2. `follow-up`: the follow-up request, on the app from step 1. It runs only if every check of step
   1 passed (`min_reward = { passed = 1.0 }`). Its instruction quotes the first request. It is a
   new conversation unless Harbor runs with `--resume-trajectory`.

The follow-up's checks expect the data that step 1's checks entered (the to-do "Buy milk", done),
as in the eval. A Sandburg run keeps the app's files in the browser; `test.sh` passes
`--save-files` with the pattern of SQLite files, so the verifier writes the database back into
`/app`, and the agent in step 2 finds it there. The trial's reward is the mean over the steps that
ran: `passed` is 1 if both steps passed, 0.5 if only the request did, 0 if not even that; `score`
of a trial that stopped after step 1 is that step's alone. Each step's reward is in
`steps/<name>/verifier/`.

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

Commands run with `bash -c`, as the current user, with a `sandburg` command on `PATH`, and with
only a few of this machine's environment variables (`PATH`, `HOME`, locale, proxy and CA settings,
`SANDBURG_*`; `SANDBURG_HARBOR_PASS_ENV` adds names), as a container starts clean. Harbor adds the
trial's own variables, such as the agent's API key. The `sandburg` command installs an app's
packages in the browser unless `--install-in` says otherwise, and all trials share one HTTP cache
(`SANDBURG_HARBOR_CACHE`, default `~/.cache/sandburg-harbor`).

Known gaps:

- Claude Code names its session folder after its working directory: here `projects/-tmp-…-app`,
  not `projects/-app`. Harbor's trajectory (`agent/trajectory.json`) is complete; resuming a
  session (the agent's `load` option) and `memory_dir`, which use `projects/-app`, do not work.
- A path the agent's own tools use inside its process (not in a command Harbor runs) is not
  mapped. The instructions talk about the current directory, not `/app`.
- Network policies and resource limits are not enforced.
