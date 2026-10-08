"""Path mapping of the Sandburg environment: `python -m pytest integrations/harbor` (Harbor installed)."""

import asyncio
import logging
from pathlib import Path

import pytest

from harbor.models.task.config import EnvironmentConfig
from harbor.models.trial.paths import TrialPaths

from sandburg_harbor import SandburgEnvironment


@pytest.fixture(autouse=True)
def _stop_environments():
    yield
    for env in _started:
        asyncio.run(env.stop(delete=True))
    _started.clear()


_started: list[SandburgEnvironment] = []


def environment(tmp_path: Path) -> SandburgEnvironment:
    trial = TrialPaths(trial_dir=tmp_path / "trial")
    trial.mkdir()
    env = SandburgEnvironment(
        environment_dir=tmp_path / "missing",
        environment_name="t",
        session_id="t__env",
        trial_paths=trial,
        task_env_config=EnvironmentConfig(workdir="/app"),
        logger=logging.getLogger("test"),
        mounts=[{"type": "bind", "source": str(trial.agent_dir), "target": "/logs/agent"}],
    )
    asyncio.run(env.start(force_build=False))
    _started.append(env)
    return env


def test_maps_environment_paths_at_path_boundaries(tmp_path: Path) -> None:
    env = environment(tmp_path)
    agent = env.trial_paths.agent_dir
    assert env._map("tee /logs/agent/out.txt") == f"tee {agent}/out.txt"
    assert env._map("cd /app && ls") == f"cd {env.root / 'app'} && ls"
    assert env._map('bash "/tests/test.sh"') == f'bash "{env.root / "tests"}/test.sh"'
    for untouched in ("/application", "/appx", "foo/app", "https://x.dev/app"):
        assert env._map(untouched) == untouched


def test_exec_runs_in_the_workdir_with_mapped_paths(tmp_path: Path) -> None:
    env = environment(tmp_path)
    result = asyncio.run(env.exec("pwd && echo hi > /logs/agent/hi.txt && command -v sandburg"))
    assert result.return_code == 0, result.stderr
    lines = result.stdout.splitlines()
    assert lines[0] == str(env.root / "app")
    assert (env.trial_paths.agent_dir / "hi.txt").read_text() == "hi\n"
    assert lines[1].endswith("/.bin/sandburg")


def test_uploaded_scripts_get_mapped_paths(tmp_path: Path) -> None:
    env = environment(tmp_path)
    script = tmp_path / "test.sh"
    script.write_text("echo 1 > /logs/verifier/reward.txt\n")
    asyncio.run(env.upload_file(script, "/tests/test.sh"))
    assert (env.root / "tests" / "test.sh").read_text() == f"echo 1 > {env.root / 'logs'}/verifier/reward.txt\n"


def test_commands_do_not_inherit_an_outer_agents_variables(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CLAUDECODE", "1")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://outer")
    monkeypatch.setenv("SANDBURG_CHROMIUM", "/x/chromium")
    env = environment(tmp_path)
    out = asyncio.run(env.exec('echo "${CLAUDECODE:-unset} ${ANTHROPIC_BASE_URL:-unset} $SANDBURG_CHROMIUM"', env={"A": "/app/x"}))
    assert out.stdout.strip() == "unset unset /x/chromium"
    assert asyncio.run(env.exec("echo $A", env={"A": "/app/x"})).stdout.strip() == f"{env.root / 'app'}/x"


def fake_sandburg(tmp_path: Path, monkeypatch) -> None:
    """A Sandburg whose command line prints its arguments, one per line."""
    home = tmp_path / "home"
    (home / "bin").mkdir(parents=True)
    (home / "bin" / "sandburg.js").write_text("for (const a of process.argv.slice(2)) console.log(a);\n")
    monkeypatch.setenv("SANDBURG_HOME", str(home))


def test_sandburg_runs_the_project_with_checks_in_the_page(tmp_path: Path, monkeypatch) -> None:
    fake_sandburg(tmp_path, monkeypatch)
    env = environment(tmp_path)
    app = env.root / "app"
    out = asyncio.run(env.exec("sandburg run . --checks checks.spec.ts --json"))
    assert out.return_code == 0, out.stderr
    args = out.stdout.splitlines()
    assert args[:2] == ["run", str(app)]
    assert args[args.index("--install-in") + 1] == "browser"
    assert args[args.index("--checks-in") + 1] == "page"
    assert args[args.index("--checks") + 1] == str(app / "checks.spec.ts")
    assert args[args.index("--out") + 1] == str(app / ".sandburg" / "runs")
    assert "--cache" in args and "--json" in args


def test_sandburg_refuses_what_reaches_beyond_the_project(tmp_path: Path, monkeypatch) -> None:
    fake_sandburg(tmp_path, monkeypatch)
    env = environment(tmp_path)
    (env.root / "elsewhere").mkdir()
    (env.root / "app" / "link").symlink_to(env.root / "elsewhere")
    for command, why in [
        ("sandburg run /etc", "not inside the project"),
        ("sandburg run ..", "not inside the project"),
        ("sandburg run link", "not inside the project"),
        ("sandburg run . --checks ../checks.ts", "not inside the project"),
        ("sandburg run . --out /tmp/x", "not inside the project"),
        ("sandburg run . --checks-in host --checks a.spec.ts", "checks run in the page"),
        ("sandburg run . --install-in host", "installed in the browser"),
        ("sandburg run . --cache /tmp/c", "Unknown option"),
        ("sandburg compare .", 'only "sandburg run"'),
        ("sandburg run . -- --checks-in host", "unexpected arguments"),
    ]:
        out = asyncio.run(env.exec(command))
        assert out.return_code == 64, (command, out.stdout)
        assert why in out.stderr, (command, out.stderr)
        assert out.stdout == "", command
