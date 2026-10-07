"""
A Harbor job's trials as a table: each step's reward, and for an agent with a trajectory, its cost,
turns, `sandburg` runs and refused tool calls.

    python integrations/harbor/summarize.py <job dir> [--json]
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime
from pathlib import Path


def seconds(timing: dict | None) -> float | None:
    if not timing or not timing.get("started_at") or not timing.get("finished_at"):
        return None
    parse = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
    return (parse(timing["finished_at"]) - parse(timing["started_at"])).total_seconds()


# A command that runs `sandburg run` (perhaps after a cd), not one that mentions it.
RUN = re.compile(r"^(?:cd [^;&]+(?:&&|;)\s*)?sandburg run\b")


def tools(trajectory: Path) -> dict:
    if not trajectory.exists():
        return {}
    steps = json.loads(trajectory.read_text()).get("steps", [])
    calls = [c for s in steps for c in s.get("tool_calls") or []]
    results = [r for s in steps for r in (s.get("observation") or {}).get("results") or []]
    return {
        "turns": sum(1 for s in steps if s.get("source") == "agent"),
        "sandburg_runs": sum(
            1
            for c in calls
            if c.get("function_name") == "Bash" and RUN.match((c.get("arguments") or {}).get("command", ""))
        ),
        "denied": sum(1 for r in results if "has been denied" in str(r.get("content", ""))),
    }


def trial(dir: Path) -> dict:
    result = json.loads((dir / "result.json").read_text())
    steps = result.get("step_results") or [
        {"step_name": "-", **{k: result.get(k) for k in ("agent_result", "verifier_result", "exception_info", "agent_execution", "verifier")}}
    ]
    out = {"task": result["task_name"].removeprefix("sandburg/"), "trial": dir.name, "steps": []}
    for step in steps:
        agent_dir = dir / "steps" / step["step_name"] / "agent" if step["step_name"] != "-" else dir / "agent"
        agent = step.get("agent_result") or {}
        out["steps"].append({
            "name": step["step_name"],
            "rewards": (step.get("verifier_result") or {}).get("rewards"),
            "error": (step.get("exception_info") or {}).get("exception_type"),
            "agent_s": seconds(step.get("agent_execution")),
            "verifier_s": seconds(step.get("verifier")),
            "cost_usd": agent.get("cost_usd"),
            **tools(agent_dir / "trajectory.json"),
        })
    out["rewards"] = (result.get("verifier_result") or {}).get("rewards")
    out["error"] = (result.get("exception_info") or {}).get("exception_type")
    return out


def main(argv: list[str]) -> None:
    job = Path(argv[0])
    trials = [trial(d) for d in sorted(job.iterdir()) if (d / "result.json").exists() and d.is_dir()]
    if "--json" in argv:
        print(json.dumps(trials, indent=2))
        return
    fmt = lambda v, f="{:.0f}": "-" if v is None else f.format(v)
    print(f"{'task':28} {'step':10} {'score':>5} {'pass':>4} {'agent s':>7} {'verif s':>7} {'$':>5} {'turns':>5} {'runs':>4} {'denied':>6}  error")
    total_cost = 0.0
    for t in trials:
        for s in t["steps"]:
            r = s["rewards"] or {}
            total_cost += s["cost_usd"] or 0
            print(
                f"{t['task']:28} {s['name']:10} {fmt(r.get('score'), '{:.2f}'):>5} {fmt(r.get('passed')):>4} "
                f"{fmt(s['agent_s']):>7} {fmt(s['verifier_s']):>7} {fmt(s['cost_usd'], '{:.2f}'):>5} "
                f"{fmt(s.get('turns')):>5} {fmt(s.get('sandburg_runs')):>4} {fmt(s.get('denied')):>6}  {s['error'] or t['error'] or ''}"
            )
    passed = [t["rewards"].get("passed", 0) if t["rewards"] else 0 for t in trials]
    both = sum(1 for p in passed if p == 1)
    print(f"\n{len(trials)} trials: {both} passed every step, mean passed {sum(passed) / max(len(trials), 1):.2f}, cost ${total_cost:.2f}")


if __name__ == "__main__":
    main(sys.argv[1:])
