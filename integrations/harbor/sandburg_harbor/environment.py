"""
A Harbor environment without containers: the agent works in a directory on this machine, and the
app it builds runs in Sandburg, in a browser tab (`sandburg run`).

Harbor addresses an environment through fixed absolute paths: the task's workdir (`/app`),
`/tests`, `/solution` and `/logs/...`. A container has those paths; this machine does not, and
on macOS a process cannot be given its own view of the file system. So each trial gets a root
directory, and the environment maps those paths into it:

- in each command it runs, its working directory and its environment variables;
- in the scripts Harbor uploads to `/tests` and `/solution` (a task's `test.sh` writes
  `/logs/verifier/reward.json`);
- for uploads and downloads.

`/logs/agent`, `/logs/verifier` and `/logs/artifacts` map straight to the trial's own log folders
(the mounts Harbor passes in), so Harbor reads them without copying.

Commands run with `bash -c` on this machine, as the current user, with a `sandburg` command on
`PATH` (browser installs and a shared HTTP cache by default), and only a few of this machine's environment variables (PASS_ENV). Nothing here isolates the agent: limit what it may run with its own permissions (for
Claude Code, `permission_mode=dontAsk` and an `allowed_tools` list). What isolation there is
belongs to the app: its packages are installed, and its code runs, in Sandburg's browser tab.
"""

from __future__ import annotations

import asyncio
import os
import re
import shlex
import shutil
import tempfile
from pathlib import Path

from harbor.environments.base import BaseEnvironment, ExecResult
from harbor.environments.capabilities import EnvironmentCapabilities

# The repository this file is in: its `bin/sandburg.js` is the `sandburg` command.
SANDBURG_HOME = Path(os.environ.get("SANDBURG_HOME", Path(__file__).resolve().parents[3]))

# What a command gets from this machine's environment, as a container would start clean: the rest
# (an outer agent's own variables, API endpoints) would leak into the agent. Harbor adds the
# trial's variables (the agent's API key and model) per command. SANDBURG_HARBOR_PASS_ENV adds
# more names (comma-separated).
PASS_ENV = {
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TMPDIR", "TZ",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
}


def host_environment() -> dict[str, str]:
    extra = {n.strip() for n in os.environ.get("SANDBURG_HARBOR_PASS_ENV", "").split(",") if n.strip()}
    return {
        k: v
        for k, v in os.environ.items()
        if k in PASS_ENV or k in extra or k.startswith(("LC_", "SANDBURG_"))
    }


# Scripts Harbor uploads and runs here; their paths are mapped like a command's.
SCRIPT_SUFFIXES = {".sh", ".bash", ""}


class SandburgEnvironment(BaseEnvironment):
    @staticmethod
    def type() -> str:
        return "sandburg"

    @property
    def capabilities(self) -> EnvironmentCapabilities:
        # The log folders are the trial's own (see _paths): Harbor reads them in place.
        return EnvironmentCapabilities(mounted=True)

    def _validate_definition(self) -> None:
        # No image or Dockerfile: a task's environment/ folder, if any, is the project's starting files.
        pass

    @property
    def workdir(self) -> str:
        return self.task_env_config.workdir or "/app"

    async def start(self, force_build: bool) -> None:
        self.root = Path(tempfile.mkdtemp(prefix=f"sandburg-harbor-{self.environment_name}-"))
        self.mapping: list[tuple[str, Path]] = []
        for mount in self._mounts:
            if mount.get("type") == "bind" and mount.get("source"):
                self.mapping.append((mount["target"].rstrip("/"), Path(mount["source"])))
        # Fixed paths Harbor and its agents use besides the mounts (Claude Code's settings go to
        # /tmp/claude-code-settings): each trial gets its own.
        for path in (self.workdir, "/tests", "/solution", "/logs", "/installed-agent", "/tmp/harbor", "/tmp/claude-code-settings"):
            if not any(target == path for target, _ in self.mapping):
                self.mapping.append((path.rstrip("/"), self.root / path.strip("/")))
        # Longest first, so /logs/agent wins over /logs.
        self.mapping.sort(key=lambda m: len(m[0]), reverse=True)
        for _, host in self.mapping:
            host.mkdir(parents=True, exist_ok=True)
        self._pattern = re.compile(
            r"(?<![\w./-])(" + "|".join(re.escape(t) for t, _ in self.mapping) + r")(?=[/\s'\"`;:|&)<>]|$)"
        )
        bin_dir = self.root / ".bin"
        bin_dir.mkdir(exist_ok=True)
        sandburg = bin_dir / "sandburg"
        # Runs install the app's packages in the browser (not with npm on this machine) unless told
        # otherwise, and share one HTTP cache across trials (keyed by URL; package documents are
        # fetched again when stale), so that each trial does not download everything again.
        cache = Path(os.environ.get("SANDBURG_HARBOR_CACHE", Path.home() / ".cache" / "sandburg-harbor"))
        sandburg.write_text(
            "#!/bin/sh\n"
            'case "$1" in run|open|batch)\n'
            '  case " $* " in *" --install-in"*) ;; *) set -- "$@" --install-in browser ;; esac\n'
            f'  case " $* " in *" --cache"*) ;; *) set -- "$@" --cache {shlex.quote(str(cache))} ;; esac ;;\n'
            "esac\n"
            f'exec node {shlex.quote(str(SANDBURG_HOME / "bin" / "sandburg.js"))} "$@"\n'
        )
        sandburg.chmod(0o755)
        self._bin_dir = bin_dir
        # The task's starting files (a stack's scaffold) go into the workdir.
        if self.environment_dir.is_dir():
            shutil.copytree(self.environment_dir, self._host(self.workdir), dirs_exist_ok=True)

    async def stop(self, delete: bool) -> None:
        if delete and getattr(self, "root", None):
            shutil.rmtree(self.root, ignore_errors=True)

    # Paths -------------------------------------------------------------------------------------

    def _host(self, path: str) -> Path:
        """An environment path as a path on this machine."""
        return Path(self._map(str(path)))

    def _map(self, text: str) -> str:
        """Every environment path in `text` (a command, a script, a value) as its path here."""
        hosts = dict(self.mapping)
        return self._pattern.sub(lambda m: str(hosts[m.group(1)]), text)

    # Commands ----------------------------------------------------------------------------------

    async def exec(
        self,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: int | None = None,
        user: str | int | None = None,
    ) -> ExecResult:
        merged = self._merge_env(env) or {}
        environ = {**host_environment(), **{k: self._map(v) for k, v in merged.items()}}
        environ["PATH"] = f"{self._bin_dir}{os.pathsep}{environ.get('PATH', '')}"
        # The task's checks load the eval's suite from Sandburg's repository.
        environ.setdefault("SANDBURG_HOME", str(SANDBURG_HOME))
        process = await asyncio.create_subprocess_exec(
            "bash",
            "-c",
            self._map(command),
            cwd=self._host(cwd or self.workdir),
            env=environ,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout_sec)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            return ExecResult(stdout=None, stderr=f"timed out after {timeout_sec} s", return_code=124)
        return ExecResult(
            stdout=stdout.decode(errors="replace"),
            stderr=stderr.decode(errors="replace"),
            return_code=process.returncode if process.returncode is not None else -1,
        )

    # Files -------------------------------------------------------------------------------------

    async def upload_file(self, source_path: Path | str, target_path: str) -> None:
        target = self._host(target_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path, target)
        self._map_script(target)

    async def upload_dir(self, source_dir: Path | str, target_dir: str) -> None:
        target = self._host(target_dir)
        shutil.copytree(source_dir, target, dirs_exist_ok=True)
        for file in target.rglob("*"):
            if file.is_file():
                self._map_script(file)

    async def download_file(self, source_path: str, target_path: Path | str) -> None:
        source = self._host(source_path)
        if Path(target_path).resolve() != source.resolve():
            Path(target_path).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target_path)

    async def download_dir(self, source_dir: str, target_dir: Path | str) -> None:
        source = self._host(source_dir)
        if Path(target_dir).resolve() != source.resolve():
            shutil.copytree(source, target_dir, dirs_exist_ok=True)

    def _map_script(self, file: Path) -> None:
        """A script Harbor will run here (test.sh, solve.sh) gets its environment paths mapped too."""
        under = (self._host("/tests"), self._host("/solution"))
        if file.suffix not in SCRIPT_SUFFIXES or not any(file.is_relative_to(d) for d in under):
            return
        try:
            text = file.read_text()
        except UnicodeDecodeError:
            return
        mapped = self._map(text)
        if mapped != text:
            file.write_text(mapped)
