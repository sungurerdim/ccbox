"""Run operations for ccbox.

Handles container execution, diagnostics, and the main run workflow.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from rich.console import Console
from rich.panel import Panel

from .. import sleepctl
from ..config import (
    DOCKER_COMMAND_TIMEOUT,
    Config,
    ConfigPathError,
    LanguageStack,
    image_exists,
)
from ..deps import DepsInfo, DepsMode, detect_dependencies
from ..detector import detect_project_type
from ..generator import get_docker_run_cmd
from ..logging import get_logger
from ..paths import validate_project_path
from .build import (
    build_image,
    build_project_image,
    ensure_image_ready,
    get_project_image_name,
    project_image_exists,
)
from .cleanup import prune_stale_resources
from .prompts import prompt_deps, resolve_stack, setup_git_config
from .utils import ERR_DOCKER_NOT_RUNNING, _check_docker_status, check_docker

console = Console()
logger = get_logger(__name__)


def diagnose_container_failure(returncode: int, project_name: str) -> None:
    """Diagnose container failure and provide actionable feedback.

    Args:
        returncode: Container exit code.
        project_name: Name of the project for container lookup.
    """
    # Known exit codes
    if returncode == 137:
        console.print("[yellow]Container was killed (OOM or manual stop)[/yellow]")
        console.print("[dim]Try: ccbox --unrestricted (removes memory limits)[/dim]")
        return
    if returncode == 139:
        console.print("[yellow]Container crashed (segmentation fault)[/yellow]")
        return
    if returncode == 143:
        console.print("[dim]Container terminated by signal[/dim]")
        return

    # Check Docker daemon health
    if not _check_docker_status():
        console.print("[red]Docker daemon is not responding[/red]")
        console.print("[dim]Docker may have restarted or crashed during session[/dim]")
        return

    # Check for container still running (shouldn't happen with --rm)
    try:
        result = subprocess.run(
            ["docker", "ps", "-q", "--filter", f"name=ccbox-{project_name}"],
            capture_output=True,
            text=True,
            check=False,
            timeout=DOCKER_COMMAND_TIMEOUT,
        )
        if result.stdout.strip():
            console.print("[yellow]Container still running (cleanup failed)[/yellow]")
            console.print(f"[dim]Run: docker rm -f ccbox-{project_name}[/dim]")
            return
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass

    # Generic error with exit code
    if returncode != 0:
        console.print(f"[yellow]Container exited with code {returncode}[/yellow]")
        console.print("[dim]Run with --debug-logs to preserve logs for investigation[/dim]")


def execute_container(
    config: Config,
    project_path: Path,
    project_name: str,
    stack: LanguageStack,
    *,
    bare: bool = False,
    debug_logs: bool = False,
    debug: int = 0,
    prompt: str | None = None,
    model: str | None = None,
    quiet: bool = False,
    append_system_prompt: str | None = None,
    project_image: str | None = None,
    deps_list: list[DepsInfo] | None = None,
    inhibit_sleep: bool = True,
    unrestricted: bool = False,
) -> None:
    """Execute the container with Claude Code.

    Args:
        config: ccbox configuration.
        project_path: Path to the project.
        project_name: Name of the project.
        stack: Stack to run.
        bare: If True, only mount credentials (no CCO).
        debug_logs: If True, persist debug logs; otherwise use tmpfs.
        debug: Debug level (0=off, 1=basic, 2=verbose+stream).
        prompt: Initial prompt (enables --print, implies --verbose unless quiet).
        model: Model to use (e.g., opus, sonnet, haiku).
        quiet: Quiet mode (enables --print, shows only Claude's responses).
        append_system_prompt: Custom instructions to append to system prompt.
        project_image: Project-specific image with deps (overrides stack image).
        deps_list: List of detected dependencies (for cache mounts).
        inhibit_sleep: If True, prevent system sleep during execution.
        unrestricted: If True, remove CPU/priority limits.
    """
    console.print("[dim]Starting Claude Code...[/dim]\n")

    try:
        cmd = get_docker_run_cmd(
            config,
            project_path,
            project_name,
            stack,
            bare=bare,
            debug_logs=debug_logs,
            debug=debug,
            prompt=prompt,
            model=model,
            quiet=quiet,
            append_system_prompt=append_system_prompt,
            project_image=project_image,
            deps_list=deps_list,
            unrestricted=unrestricted,
        )
    except ConfigPathError as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)

    # Stream mode (-dd): close stdin for watch-only (no user input)
    stdin = subprocess.DEVNULL if debug >= 2 else None

    returncode = 0
    try:
        if inhibit_sleep:
            returncode = sleepctl.run_with_sleep_inhibition(cmd, stdin=stdin)
        else:
            result = subprocess.run(cmd, check=False, stdin=stdin, text=True, timeout=1800)
            returncode = result.returncode
    except subprocess.CalledProcessError as e:
        returncode = e.returncode
    except KeyboardInterrupt:
        returncode = 130  # Standard Ctrl+C code

    # Handle exit codes
    if returncode not in (0, 130):  # 0 = success, 130 = Ctrl+C
        diagnose_container_failure(returncode, project_name)
        sys.exit(returncode)


def try_run_existing_image(
    config: Config,
    project_path: Path,
    project_name: str,
    stack: LanguageStack,
    build_only: bool,
    *,
    bare: bool = False,
    debug_logs: bool = False,
    debug: int = 0,
    prompt: str | None = None,
    model: str | None = None,
    quiet: bool = False,
    append_system_prompt: str | None = None,
    inhibit_sleep: bool = True,
    unrestricted: bool = False,
) -> bool:
    """Try to run using existing project image. Returns True if handled."""
    if not project_image_exists(project_name, stack):
        return False

    project_image = get_project_image_name(project_name, stack)
    console.print(f"[dim]Using existing project image: {project_image}[/dim]")

    console.print()
    console.print(
        Panel.fit(
            f"[bold]{project_name}[/bold] → {project_image}",
            border_style="blue",
        )
    )

    if build_only:
        console.print("[green]✓ Build complete (image exists)[/green]")
        return True

    # Detect deps for cache mounts (no prompt)
    deps_list = detect_dependencies(project_path) if not bare else []

    execute_container(
        config,
        project_path,
        project_name,
        stack,
        bare=bare,
        debug_logs=debug_logs,
        debug=debug,
        prompt=prompt,
        model=model,
        quiet=quiet,
        append_system_prompt=append_system_prompt,
        project_image=project_image,
        deps_list=deps_list,
        inhibit_sleep=inhibit_sleep,
        unrestricted=unrestricted,
    )
    return True


def build_and_run(
    config: Config,
    project_path: Path,
    project_name: str,
    selected_stack: LanguageStack,
    deps_list: list[DepsInfo],
    resolved_deps_mode: DepsMode,
    build_only: bool,
    *,
    bare: bool = False,
    debug_logs: bool = False,
    debug: int = 0,
    prompt: str | None = None,
    model: str | None = None,
    quiet: bool = False,
    append_system_prompt: str | None = None,
    inhibit_sleep: bool = True,
    unrestricted: bool = False,
) -> None:
    """Build images and run container (Phase 3)."""
    console.print()
    console.print(
        Panel.fit(
            f"[bold]{project_name}[/bold] → ccbox:{selected_stack.value}",
            border_style="blue",
        )
    )

    # Ensure base image exists (required for all stacks)
    if not image_exists(LanguageStack.BASE):
        console.print("[bold]First-time setup: building base image...[/bold]")
        if not build_image(LanguageStack.BASE):
            sys.exit(1)
        console.print()

    # Ensure stack image is ready
    if not ensure_image_ready(selected_stack, build_only=False):
        sys.exit(1)

    # Build project-specific image if deps requested
    built_project_image: str | None = None
    if resolved_deps_mode != DepsMode.SKIP and deps_list:
        built_project_image = build_project_image(
            project_path,
            project_name,
            selected_stack,
            deps_list,
            resolved_deps_mode,
        )
        if not built_project_image:
            console.print(
                "[yellow]Warning: Failed to build project image, continuing without deps[/yellow]"
            )

    if build_only:
        console.print("[green]✓ Build complete[/green]")
        return

    execute_container(
        config,
        project_path,
        project_name,
        selected_stack,
        bare=bare,
        debug_logs=debug_logs,
        debug=debug,
        prompt=prompt,
        model=model,
        quiet=quiet,
        append_system_prompt=append_system_prompt,
        project_image=built_project_image,
        deps_list=deps_list if resolved_deps_mode != DepsMode.SKIP else None,
        inhibit_sleep=inhibit_sleep,
        unrestricted=unrestricted,
    )


def run(
    stack_name: str | None,
    build_only: bool,
    path: str,
    *,
    bare: bool = False,
    debug_logs: bool = False,
    deps_mode: str | None = None,
    debug: int = 0,
    prompt: str | None = None,
    model: str | None = None,
    quiet: bool = False,
    append_system_prompt: str | None = None,
    unattended: bool = False,
    prune: bool = True,
    inhibit_sleep: bool = True,
    unrestricted: bool = False,
) -> None:
    """Run Claude Code in Docker container."""
    logger.info("Starting run workflow: path=%s, stack=%s", path, stack_name)
    if not check_docker():
        console.print(ERR_DOCKER_NOT_RUNNING)
        console.print("Start Docker and try again.")
        sys.exit(1)

    # Pre-run cleanup: remove stale resources (crashed containers, dangling images, old cache)
    if prune:
        prune_stale_resources(verbose=debug > 0)

    # Validate project path early
    try:
        project_path = validate_project_path(path)
    except ConfigPathError as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)

    config = setup_git_config()
    project_name = project_path.name

    # Detect recommended stack first (no prompt yet)
    detection = detect_project_type(project_path)
    if stack_name and stack_name != "auto":
        initial_stack = LanguageStack(stack_name)
    else:
        initial_stack = detection.recommended_stack

    # Phase 1: Try existing project image (skip prompts if found)
    if try_run_existing_image(
        config,
        project_path,
        project_name,
        initial_stack,
        build_only,
        bare=bare,
        debug_logs=debug_logs,
        debug=debug,
        prompt=prompt,
        model=model,
        quiet=quiet,
        append_system_prompt=append_system_prompt,
        inhibit_sleep=inhibit_sleep,
        unrestricted=unrestricted,
    ):
        return

    # Phase 2: No project image - prompt for deps, then stack

    # Detect dependencies
    deps_list = detect_dependencies(project_path) if not bare else []
    resolved_deps_mode = DepsMode.SKIP

    # Prompt for deps first (before stack selection)
    if deps_list and deps_mode != "skip":
        if deps_mode:
            # User specified deps mode via flag
            resolved_deps_mode = DepsMode(deps_mode)
        elif unattended:
            # Unattended mode (-y): install all deps without prompting
            resolved_deps_mode = DepsMode.ALL
            console.print("[dim]Unattended mode: installing all dependencies[/dim]")
        else:
            # Interactive prompt
            resolved_deps_mode = prompt_deps(deps_list)
            console.print()

    # Now resolve stack (with selection menu if needed)
    selected_stack = resolve_stack(
        stack_name, project_path, skip_if_image_exists=True, unattended=unattended
    )
    if selected_stack is None:
        console.print("[yellow]Cancelled.[/yellow]")
        sys.exit(0)

    # Phase 3: Build and run
    build_and_run(
        config,
        project_path,
        project_name,
        selected_stack,
        deps_list,
        resolved_deps_mode,
        build_only,
        bare=bare,
        debug_logs=debug_logs,
        debug=debug,
        prompt=prompt,
        model=model,
        quiet=quiet,
        append_system_prompt=append_system_prompt,
        inhibit_sleep=inhibit_sleep,
        unrestricted=unrestricted,
    )
