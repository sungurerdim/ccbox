"""CLI package for ccbox.

This package contains the CLI commands and supporting modules:
- commands: Click command definitions
- run: Container execution logic
- build: Image building operations
- cleanup: Resource cleanup operations
- prompts: User interaction and selection
- utils: Utilities (Docker checks, git config)

Lazy Import Strategy:
    Heavy modules (run, build, cleanup, prompts, deps, detector, generator) are
    deferred until actually needed. This reduces startup time for --help/--version
    from ~280ms to ~80ms. Re-exports for backward compatibility use __getattr__.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

# Configure UTF-8 encoding for Windows console output
# This prevents UnicodeEncodeError when Rich outputs Unicode characters (→, ✓, etc.)
# Must happen before any output, including Rich Console initialization
if sys.platform == "win32":
    # Reconfigure stdout/stderr to use UTF-8 with error replacement
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import click
from rich.console import Console
from rich.table import Table

from .. import __version__
from ..config import STACK_INFO, LanguageStack
from ..constants import MAX_PROMPT_LENGTH, MAX_SYSTEM_PROMPT_LENGTH, VALID_MODELS
from ..errors import ValidationError
from .utils import (
    ERR_DOCKER_NOT_RUNNING,
    check_docker,
    get_git_config,
)

console = Console(force_terminal=True, legacy_windows=False)


def _validate_prompt(prompt: str | None) -> str | None:
    """Validate and normalize prompt parameter.

    Returns:
        Normalized prompt string or None.

    Raises:
        ValidationError: If prompt is invalid.
    """
    if prompt is None:
        return None
    prompt = prompt.strip()
    if not prompt:
        raise ValidationError("--prompt cannot be empty or whitespace-only")
    if len(prompt) > MAX_PROMPT_LENGTH:
        raise ValidationError(f"--prompt must be {MAX_PROMPT_LENGTH} characters or less")
    return prompt


def _validate_system_prompt(prompt: str | None) -> str | None:
    """Validate and normalize append-system-prompt parameter.

    Returns:
        Normalized prompt string or None.

    Raises:
        ValidationError: If prompt is invalid.
    """
    if prompt is None:
        return None
    prompt = prompt.strip()
    if not prompt:
        raise ValidationError("--append-system-prompt cannot be empty or whitespace-only")
    if len(prompt) > MAX_SYSTEM_PROMPT_LENGTH:
        raise ValidationError(
            f"--append-system-prompt must be {MAX_SYSTEM_PROMPT_LENGTH} characters or less"
        )
    return prompt


def _validate_model(model: str | None) -> str | None:
    """Validate model parameter (warns on unknown, doesn't block).

    Returns:
        Original model string or None.
    """
    if model is not None:
        model_lower = model.lower()
        if model_lower not in VALID_MODELS:
            console.print(
                f"[yellow]Warning: Unknown model '{model}'. "
                f"Known models: {', '.join(sorted(VALID_MODELS))}[/yellow]"
            )
    return model


# Lazy import mappings for backward compatibility
# Maps exported name -> (module_path, attribute_name)
_LAZY_IMPORTS: dict[str, tuple[str, str]] = {
    # cli/build.py
    "build_image": (".build", "build_image"),
    "get_installed_ccbox_images": (".build", "get_installed_ccbox_images"),
    "_project_image_exists": (".build", "project_image_exists"),
    "_get_project_image_name": (".build", "get_project_image_name"),
    # cli/cleanup.py
    "remove_ccbox_containers": (".cleanup", "remove_ccbox_containers"),
    "remove_ccbox_images": (".cleanup", "remove_ccbox_images"),
    # cli/prompts.py
    "select_stack": (".prompts", "select_stack"),
    # cli/utils.py
    "_start_docker_desktop": (".utils", "_start_docker_desktop"),
    # config.py
    "image_exists": ("..config", "image_exists"),
    # detector.py
    "detect_project_type": ("..detector", "detect_project_type"),
    # deps.py
    "detect_dependencies": ("..deps", "detect_dependencies"),
    # generator.py
    "write_build_files": ("..generator", "write_build_files"),
}


def __getattr__(name: str) -> object:
    """Lazy import handler for backward compatibility.

    Allows `from ccbox.cli import build_image` without loading build module
    at package import time. Only loads when the attribute is actually accessed.
    """
    if name in _LAZY_IMPORTS:
        module_path, attr_name = _LAZY_IMPORTS[name]
        # Use importlib for relative imports
        import importlib

        if module_path.startswith(".."):
            # Parent package modules: ..config -> ccbox.config
            full_module = f"ccbox{module_path[1:]}"
        else:
            # Submodules: .build -> ccbox.cli.build
            full_module = f"ccbox.cli.{module_path[1:]}"
        module = importlib.import_module(full_module)
        return getattr(module, attr_name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


# Re-export for backward compatibility (lazy-loaded via __getattr__)
# These exports allow external code to import from ccbox.cli directly
# instead of from submodules. Actual loading is deferred until access.
__all__ = [
    # cli/__init__.py (always loaded)
    "cli",
    # cli/utils.py (always loaded - lightweight)
    "check_docker",
    "get_git_config",
    "_start_docker_desktop",  # lazy
    # cli/build.py (lazy)
    "build_image",
    "get_installed_ccbox_images",
    "_project_image_exists",
    "_get_project_image_name",
    # cli/cleanup.py (lazy)
    "remove_ccbox_containers",
    "remove_ccbox_images",
    # cli/prompts.py (lazy)
    "select_stack",
    # config.py (lazy)
    "image_exists",
    # detector.py (lazy)
    "detect_project_type",
    # deps.py (lazy)
    "detect_dependencies",
    # generator.py (lazy)
    "write_build_files",
]


@click.group(invoke_without_command=True)
@click.option(
    "--yes",
    "-y",
    is_flag=True,
    help="Unattended mode: auto-confirm all prompts",
)
@click.option(
    "--stack",
    "-s",
    type=click.Choice(["auto", *[s.value for s in LanguageStack]]),
    help="Language stack (auto=detect from project)",
)
@click.option("--build", "-b", is_flag=True, help="Build image only (no start)")
@click.option("--path", default=".", type=click.Path(exists=True), help="Project path")
@click.option(
    "--chdir",
    "-C",
    type=click.Path(exists=True, file_okay=False, resolve_path=True),
    help="Change to directory before running (like git -C)",
)
@click.option("--bare", is_flag=True, help="Vanilla mode: auth only, no CCO/settings/rules")
@click.option("--debug-logs", is_flag=True, help="Persist debug logs (default: ephemeral tmpfs)")
@click.option(
    "--deps", "deps_mode", flag_value="all", help="Install all dependencies (including dev)"
)
@click.option(
    "--deps-prod", "deps_mode", flag_value="prod", help="Install production dependencies only"
)
@click.option("--no-deps", "deps_mode", flag_value="skip", help="Skip dependency installation")
@click.option(
    "--debug",
    "-d",
    count=True,
    help="Debug mode (-d entrypoint logs, -dd + stream output)",
)
@click.option("--prompt", "-p", help="Initial prompt (enables --print + --verbose)")
@click.option(
    "--model",
    "-m",
    help="Model name (passed directly to Claude Code, e.g., opus, sonnet, haiku)",
)
@click.option(
    "--quiet", "-q", is_flag=True, help="Quiet mode (enables --print, shows only responses)"
)
@click.option(
    "--append-system-prompt",
    help="Append custom instructions to Claude's system prompt",
)
@click.option(
    "--no-prune",
    is_flag=True,
    help="Skip automatic cleanup of stale Docker resources",
)
@click.option(
    "--no-inhibit-sleep",
    is_flag=True,
    help="Allow system sleep during execution",
)
@click.option(
    "--unrestricted",
    "-U",
    is_flag=True,
    help="Remove CPU/priority limits (use full system resources)",
)
@click.pass_context
@click.version_option(version=__version__, prog_name="ccbox")
def cli(
    ctx: click.Context,
    yes: bool,
    stack: str | None,
    build: bool,
    path: str,
    chdir: str | None,
    bare: bool,
    debug_logs: bool,
    deps_mode: str | None,
    debug: int,
    prompt: str | None,
    model: str | None,
    quiet: bool,
    append_system_prompt: str | None,
    no_prune: bool,
    no_inhibit_sleep: bool,
    unrestricted: bool,
) -> None:
    """ccbox - Run Claude Code in isolated Docker containers.

    Simply run 'ccbox' in any project directory to start.
    """
    if ctx.invoked_subcommand is not None:
        return

    # Change directory if --chdir/-C specified (like git -C)
    if chdir:
        os.chdir(chdir)

    # Validate parameters
    try:
        prompt = _validate_prompt(prompt)
        append_system_prompt = _validate_system_prompt(append_system_prompt)
        model = _validate_model(model)
    except ValidationError as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)

    # Lazy import: run module is heavy (~15ms), only load when actually running
    from .run import run as _run

    _run(
        stack,
        build,
        path,
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


@cli.command()
@click.option("--stack", "-s", type=click.Choice([s.value for s in LanguageStack]), help="Stack")
@click.option("--all", "-a", "build_all", is_flag=True, help="Rebuild all installed images")
def update(stack: str | None, build_all: bool) -> None:
    """Rebuild Docker image(s) with latest Claude Code.

    By default, rebuilds minimal + base images from scratch.
    Use --stack to rebuild a specific stack only.
    Use --all to rebuild all currently installed images.
    """
    if not check_docker():
        console.print(ERR_DOCKER_NOT_RUNNING)
        sys.exit(1)

    # Lazy import: build module is heavy (~35ms)
    from ..config import image_exists
    from .build import build_image

    stacks_to_build: list[LanguageStack] = []

    if stack:
        stacks_to_build.append(LanguageStack(stack))
    elif build_all:
        for s in LanguageStack:
            if image_exists(s):
                stacks_to_build.append(s)
    else:
        # Default: rebuild minimal + base (full refresh)
        stacks_to_build = [LanguageStack.MINIMAL, LanguageStack.BASE]

    if not stacks_to_build:
        console.print("[yellow]No images to update.[/yellow]")
        return

    for s in stacks_to_build:
        build_image(s)


@cli.command()
@click.option("--force", "-f", is_flag=True, help="Skip confirmation")
def clean(force: bool) -> None:
    """Remove ccbox containers and images."""
    if not check_docker():
        console.print(ERR_DOCKER_NOT_RUNNING)
        sys.exit(1)

    if not force and not click.confirm("Remove all ccbox containers and images?", default=False):
        return

    # Lazy import: cleanup module is heavy (~15ms)
    from .cleanup import remove_ccbox_containers, remove_ccbox_images

    console.print("[dim]Removing containers...[/dim]")
    containers_removed = remove_ccbox_containers()

    console.print("[dim]Removing images...[/dim]")
    images_removed = remove_ccbox_images()

    console.print("[green]✓ Cleanup complete[/green]")
    if containers_removed or images_removed:
        parts = []
        if containers_removed:
            parts.append(f"{containers_removed} container(s)")
        if images_removed:
            parts.append(f"{images_removed} image(s)")
        console.print(f"[dim]Removed: {', '.join(parts)}[/dim]")


@cli.command()
@click.option("--force", "-f", is_flag=True, help="Skip confirmation")
@click.option(
    "--system",
    is_flag=True,
    help="Clean entire Docker system (all unused containers, images, volumes, cache)",
)
def prune(force: bool, system: bool) -> None:
    """Deep clean: remove ccbox or entire Docker system resources.

    By default, removes only ccbox resources (containers, images, temp files).

    With --system, removes ALL unused Docker resources system-wide:
    stopped containers, dangling images, unused volumes, and build cache.
    """
    if not check_docker():
        console.print(ERR_DOCKER_NOT_RUNNING)
        sys.exit(1)

    # Lazy import: cleanup module is heavy (~15ms)
    from .cleanup import (
        clean_temp_files,
        prune_system,
        remove_ccbox_containers,
        remove_ccbox_images,
    )

    if system:
        prune_system(force)
        return

    if not force:
        console.print("[yellow]This will remove ALL ccbox resources:[/yellow]")
        console.print("  • All ccbox containers (running + stopped)")
        console.print("  • All ccbox images (stacks + project images)")
        console.print("  • Temporary build files (/tmp/ccbox)")
        console.print()
        if not click.confirm("Continue with deep clean?", default=False):
            console.print("[dim]Cancelled.[/dim]")
            return

    # 1. Stop and remove ALL ccbox containers (including running ones)
    console.print("[dim]Removing containers...[/dim]")
    containers_removed = remove_ccbox_containers()

    # 2. Remove ALL ccbox images (stacks + project images)
    console.print("[dim]Removing images...[/dim]")
    images_removed = remove_ccbox_images()

    # Note: We intentionally do NOT prune global dangling images or build cache
    # as they may belong to other Docker projects. ccbox uses --no-cache anyway,
    # so it doesn't create intermediate build cache.

    # 3. Clean up ccbox build directory
    console.print("[dim]Removing temp files...[/dim]")
    tmpdir_removed = clean_temp_files()

    # Summary
    console.print()
    console.print("[green]✓ Deep clean complete[/green]")
    parts = []
    if containers_removed:
        parts.append(f"{containers_removed} container(s)")
    if images_removed:
        parts.append(f"{images_removed} image(s)")
    if tmpdir_removed:
        parts.append("temp files")
    if parts:
        console.print(f"[dim]Removed: {', '.join(parts)}[/dim]")
    else:
        console.print("[dim]Nothing to remove - already clean[/dim]")


@cli.command()
@click.argument("path", default=".", type=click.Path(exists=True))
def doctor(path: str) -> None:
    """Check system status and detect project type."""
    project_path = Path(path).resolve()

    from rich.panel import Panel

    # Lazy import: detector module
    from ..config import image_exists
    from ..detector import detect_project_type

    console.print(Panel.fit("[bold]ccbox Doctor[/bold]", border_style="blue"))

    # System checks
    checks: list[tuple[str, bool, str]] = []

    docker_ok = check_docker(auto_start=False)
    checks.append(("Docker running", docker_ok, "Start Docker"))

    try:
        # Use home directory for cross-platform disk check (works on Windows/Linux/macOS)
        _, _, free = shutil.disk_usage(Path.home())
        free_gb = free // (1024**3)
        checks.append((f"Disk space ({free_gb}GB)", free_gb >= 5, "Need 5GB+"))
    except (OSError, PermissionError) as e:
        console.print(f"[dim]Disk space check error: {e}[/dim]")
        checks.append(("Disk space", False, "Cannot check"))

    py_ok = sys.version_info >= (3, 8)
    checks.append((f"Python {sys.version_info.major}.{sys.version_info.minor}", py_ok, "Need 3.8+"))

    claude_dir = Path(os.path.expanduser("~/.claude"))
    checks.append(("Claude config", claude_dir.exists(), "Run 'claude' first"))

    git_name, git_email = get_git_config()
    git_ok = bool(git_name and git_email)
    checks.append(("Git configured", git_ok, "Run 'git config --global user.name/email'"))

    table = Table(title="System Status")
    table.add_column("Check")
    table.add_column("Status")
    table.add_column("Action", style="dim")

    for name, ok, action in checks:
        status = "[green]OK[/green]" if ok else "[red]FAIL[/red]"
        table.add_row(name, status, "" if ok else action)

    console.print(table)

    # Project detection
    console.print(f"\n[bold]Project: {project_path.name}[/bold]")
    detection = detect_project_type(project_path)

    if detection.detected_languages:
        console.print(f"Languages: {', '.join(detection.detected_languages)}")
    console.print(f"Stack: [cyan]{detection.recommended_stack.value}[/cyan]")

    # Installed images
    console.print("\n[bold]Installed Images:[/bold]")
    found = False
    for stack_enum in LanguageStack:
        if image_exists(stack_enum):
            desc, _ = STACK_INFO[stack_enum]
            console.print(f"  [green]ccbox:{stack_enum.value}[/green] - {desc}")
            found = True
    if not found:
        console.print("  [dim]None - run 'ccbox' to build[/dim]")


@cli.command()
def stacks() -> None:
    """List available language stacks."""
    table = Table(title="Available Stacks")
    table.add_column("Stack", style="cyan")
    table.add_column("Description")
    table.add_column("Size", justify="right")

    for stack in LanguageStack:
        desc, size = STACK_INFO[stack]
        table.add_row(stack.value, desc, f"~{size}MB")

    console.print(table)
    console.print("\n[dim]Usage: ccbox --stack=go[/dim]")
    console.print("[dim]All stacks include: Python + Node.js + lint/test tools[/dim]")
    console.print("[dim]All except 'minimal' include CCO[/dim]")


if __name__ == "__main__":  # pragma: no cover
    cli()
