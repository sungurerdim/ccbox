"""Run configuration dataclass for ccbox.

Bundles CLI arguments into a single configuration object for cleaner
function signatures and easier testing.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class RunConfig:
    """Configuration for a ccbox run session.

    Immutable dataclass bundling all CLI arguments for the run command.
    Use frozen=True for hashability and to prevent accidental mutation.
    """

    # Stack selection
    stack_name: str | None = None

    # Build options
    build_only: bool = False

    # Project path
    path: str = "."

    # Runtime options
    bare: bool = False
    debug_logs: bool = False
    deps_mode: str | None = None
    debug: int = 0

    # Claude Code options
    prompt: str | None = None
    model: str | None = None
    quiet: bool = False
    append_system_prompt: str | None = None

    # Workflow options
    unattended: bool = False
    prune: bool = True
    inhibit_sleep: bool = True
    unrestricted: bool = False

    @classmethod
    def from_cli(
        cls,
        *,
        stack: str | None = None,
        build: bool = False,
        path: str = ".",
        bare: bool = False,
        debug_logs: bool = False,
        deps_mode: str | None = None,
        debug: int = 0,
        prompt: str | None = None,
        model: str | None = None,
        quiet: bool = False,
        append_system_prompt: str | None = None,
        yes: bool = False,
        no_prune: bool = False,
        no_inhibit_sleep: bool = False,
        unrestricted: bool = False,
    ) -> RunConfig:
        """Create RunConfig from CLI arguments.

        Handles argument transformation (e.g., --yes -> unattended).
        """
        return cls(
            stack_name=stack,
            build_only=build,
            path=path,
            bare=bare,
            debug_logs=debug_logs,
            deps_mode=deps_mode,
            debug=debug,
            prompt=prompt,
            model=model,
            quiet=quiet,
            append_system_prompt=append_system_prompt,
            unattended=yes,
            prune=not no_prune,
            inhibit_sleep=not no_inhibit_sleep,
            unrestricted=unrestricted,
        )
