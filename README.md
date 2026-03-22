# ccbox

> **This project is evolving into [aifence](https://github.com/sungurerdim) — a next-generation AI sandbox** with broader scope, stronger isolation, and multi-tool support beyond Claude Code. Coming soon.

[![Status: Archived](https://img.shields.io/badge/status-archived-lightgrey?style=for-the-badge)]()

---

## What was ccbox?

**Isolated Docker sandbox for Claude Code.** Your project stays safe, Claude runs at full power.

ccbox proved that container-based isolation is the right security model for AI coding agents — the host filesystem isn't restricted inside the container, it's **absent entirely**. No policy to bypass, no permission to escalate, no path to traverse.

## What's next: aifence

ccbox was Claude Code-specific. aifence generalizes the approach:

| | ccbox | aifence |
|---|---|---|
| **AI tools** | Claude Code only | Claude Code, Cursor, Copilot, Codex, and more |
| **Isolation model** | Docker container | Multi-layer (container + permission + network) |
| **Scope** | Sandbox runner | Full AI security platform |
| **Stack support** | 20 language stacks | Extended stack detection + custom stacks |
| **Status** | Archived | In development (private) |

The core insight ccbox validated — **"can't access what doesn't exist"** — carries forward into aifence as a foundational principle.

---

## Also by the same author

**[dev-skills](https://github.com/sungurerdim/dev-skills)** — 19 production-grade AI skills for the full software lifecycle. Tool-agnostic, self-contained, token-efficient. The quality gates and AI weakness prevention that ccbox's guardrail rules pioneered are now built into every skill.

---

<details>
<summary><b>Original ccbox documentation</b></summary>

### How ccbox worked

```bash
cd your-project
ccbox
```

ccbox detected your project type, built a Docker image with the right tools, installed dependencies, and launched Claude Code in an isolated container.

| | ccbox | Claude Code Sandbox | `--worktree` |
|---|---|---|---|
| Host filesystem | **Absent** (not mounted) | Present, restricted | Full access |
| Bypass mode | Yes (container = boundary) | No (permissions enforced) | No |
| Custom tools | Pre-installed per stack | Host tools only | Host tools only |
| Reproducibility | Deterministic image | Depends on host | Depends on host |
| Side effects | Confined to container | Can affect host | Can affect host |

### Usage

```bash
ccbox                        # Interactive session
ccbox -y                     # Skip all prompts
ccbox -p "fix the tests"     # Start with a prompt
ccbox -c                     # Continue most recent session
ccbox -s python              # Force specific stack
ccbox -e MY_API_KEY=secret   # Pass env variable
```

### Security

| Protection | Description |
|------------|-------------|
| Non-root user | Runs as your UID/GID via gosu |
| Capabilities dropped | `--cap-drop=ALL`, minimal add-back |
| Process limits | `--pids-limit=2048` (fork bomb protection) |
| Resource limits | Memory 4g, CPU 2.0 (configurable) |
| Restricted mounts | Only project + `~/.claude` + tmpfs |
| Credentials | Env vars only, SSH agent read-only, no keys on disk |

### 20 Language Stacks

Auto-detected: base, python, web, go, rust, java, cpp, dotnet, swift, dart, lua, jvm, functional, scripting, systems, data, ai, fullstack, mobile, game.

### Install (archived)

**macOS / Linux / WSL:**
```bash
curl -fsSL https://raw.githubusercontent.com/sungurerdim/ccbox/main/install.sh | bash
```

**Windows (PowerShell as Admin):**
```powershell
irm https://raw.githubusercontent.com/sungurerdim/ccbox/main/install.ps1 | iex
```

</details>

---

MIT License
