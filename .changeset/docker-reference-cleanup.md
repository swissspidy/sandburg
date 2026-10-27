---
"sandburg": patch
---

The Docker reference no longer leaves containers behind: it pulls its image before the first container starts (a failed pull is an `infra` result, and mount's deadline allows for the pull), labels and `--rm`s every container, removes a run's containers by label on dispose (also one a timed-out mount was still creating) and those of earlier, dead processes at startup. Ctrl-C or SIGTERM during `compare` removes the containers and project copies before exiting with 130. Containers use bridge networking, and reach a loopback proxy through the host gateway when it listens there; `--network host` is the fallback. The README and ADR 0004 now say plainly that the Docker reference is not a security boundary.
