"""CLI for ccbox - Secure Docker environment for Claude Code."""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
import time
from pathlib import Path

import click
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from . import __version__
from .config import (
    STACK_DEPENDENCIES,
    STACK_INFO,
    Config,
    ConfigPathError,
    LanguageStack,
    get_config_dir,
    get_image_name,
    image_exists,
    load_config,
    save_config,
)
from .detector import detect_project_type
from .generator import get_docker_run_cmd, write_build_files
from .updater import check_all_updates, format_changelog

console = Console()

# Constants
DOCKER_STARTUP_TIMEOUT_SECONDS = 30
DOCKER_CHECK_INTERVAL_SECONDS = 5
ERR_DOCKER_NOT_RUNNING = "[red]Error: Docker is not running.[/red]"

# Timeout constants (seconds)
DOCKER_BUILD_TIMEOUT = 600  # 10 min for image builds
DOCKER_COMMAND_TIMEOUT = 30  # 30s for docker info/inspect/version
PIP_INSTALL_TIMEOUT = 300  # 5 min for pip operations


def _check_docker_status() -> bool:
    """Check if Docker daemon is responsive."""
    try:
        result = subprocess.run(
            ["docker", "info"],
            capture_output=True,
            text=True,
            check=False,
        )
        return result.returncode == 0
    except FileNotFoundError:
        return False


def _start_docker_desktop() -> bool:
    """Attempt to start Docker Desktop based on platform."""
    system = platform.system()

    if system == "Windows":
        result = subprocess.run(
            ["docker", "desktop", "start"],
            capture_output=True,
            check=False,
        )
        if result.returncode == 0:
            return True
        docker_path = Path(os.environ.get("PROGRAMFILES", "C:\\Program Files"))
        docker_exe = docker_path / "Docker" / "Docker" / "Docker Desktop.exe"
        if docker_exe.exists():
            subprocess.Popen([str(docker_exe)], start_new_session=True)
            return True
    elif system == "Darwin":
        subprocess.run(["open", "-a", "Docker"], capture_output=True, check=False)
        return True
    return False


def check_docker(auto_start: bool = True) -> bool:
    """Check if Docker is available and running, optionally auto-start."""
    if _check_docker_status():
        return True

    if auto_start:
        console.print("[dim]Docker not running, attempting to start...[/dim]")
        if _start_docker_desktop():
            for i in range(DOCKER_STARTUP_TIMEOUT_SECONDS):
                time.sleep(1)
                if _check_docker_status():
                    console.print("[green]Docker started successfully[/green]")
                    return True
                if i % DOCKER_CHECK_INTERVAL_SECONDS == DOCKER_CHECK_INTERVAL_SECONDS - 1:
                    console.print(f"[dim]Waiting for Docker... ({i + 1}s)[/dim]")
    return False


def ensure_base_image() -> bool:
    """Ensure base image exists, build if needed (first-time setup).

    Called automatically when building WEB or FULL stacks that depend on base.
    """
    if image_exists(LanguageStack.BASE):
        return True
    console.print("[dim]Building base image (first-time setup)...[/dim]")
    return build_image(LanguageStack.BASE)


def build_image(stack: LanguageStack) -> bool:
    """Build Docker image for stack with BuildKit optimization.

    Automatically builds base image first if the stack depends on it.
    """
    # Check if this stack depends on base image
    dependency = STACK_DEPENDENCIES.get(stack)
    if dependency is not None and not image_exists(dependency):
        console.print(f"[dim]Building dependency: ccbox:{dependency.value}...[/dim]")
        if not build_image(dependency):
            console.print(f"[red]✗ Failed to build dependency ccbox:{dependency.value}[/red]")
            return False

    image_name = get_image_name(stack)
    console.print(f"[bold]Building {image_name}...[/bold]")

    build_dir = write_build_files(stack)

    # Enable BuildKit for faster, more efficient builds
    env = os.environ.copy()
    env["DOCKER_BUILDKIT"] = "1"

    try:
        # Use timestamp-based cache bust to force rebuild of ccbox/cco layers only
        # Base layers (apt packages, etc.) remain cached for faster builds
        cachebust = str(int(time.time()))
        subprocess.run(
            [
                "docker",
                "build",
                "-t",
                image_name,
                "-f",
                str(build_dir / "Dockerfile"),
                "--build-arg",
                f"CACHEBUST={cachebust}",
                "--progress=auto",
                str(build_dir),
            ],
            check=True,
            env=env,
        )
        console.print(f"[green]✓ Built {image_name}[/green]")
        return True
    except subprocess.CalledProcessError:
        console.print(f"[red]✗ Failed to build {image_name}[/red]")
        return False


def _get_git_config_value(key: str) -> str:
    """Get a single git config value."""
    try:
        result = subprocess.run(
            ["git", "config", "--global", key],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except FileNotFoundError:
        pass
    return ""


def get_git_config() -> tuple[str, str]:
    """Get git user.name and user.email from system."""
    return _get_git_config_value("user.name"), _get_git_config_value("user.email")


def _update_ccbox_package() -> bool:
    """Update ccbox via pip. Returns True if successful."""
    console.print("[dim]Updating ccbox...[/dim]")
    result = subprocess.run(
        [sys.executable, "-m", "pip", "install", "--upgrade", "ccbox"],
        capture_output=True,
        check=False,
        timeout=PIP_INSTALL_TIMEOUT,
    )
    if result.returncode == 0:
        console.print("[green]✓ ccbox updated[/green]")
        return True
    console.print("[red]✗ Failed to update ccbox[/red]")
    return False


def _check_and_prompt_updates(stack: LanguageStack) -> bool:
    """Check for updates and prompt user. Returns True if rebuild needed."""
    console.print("[dim]Checking for updates...[/dim]")

    updates = check_all_updates(stack)
    if not updates:
        return False

    console.print()
    console.print(Panel.fit("[bold yellow]Updates Available[/bold yellow]", border_style="yellow"))

    for update in updates:
        ver_info = f"{update.current} → [green]{update.latest}[/green]"
        console.print(f"\n[bold]{update.package}[/bold]: {ver_info}")
        if update.changelog:
            console.print("[dim]Changelog:[/dim]")
            console.print(format_changelog(update.changelog))

    console.print()
    if click.confirm("Update and rebuild images?", default=True):
        # Update ccbox if needed
        ccbox_updated = False
        for update in updates:
            if update.package == "ccbox":
                ccbox_updated = _update_ccbox_package()

        if ccbox_updated:
            console.print("\n[yellow]Please restart ccbox to use the new version.[/yellow]")
            sys.exit(0)

        # CCO will be updated during image rebuild
        return True

    return False


@click.group(invoke_without_command=True)
@click.option("--stack", "-s", type=click.Choice([s.value for s in LanguageStack]), help="Stack")
@click.option("--build", "-b", is_flag=True, help="Build image only (no start)")
@click.option("--path", "-p", default=".", type=click.Path(exists=True), help="Project path")
@click.option("--no-update-check", is_flag=True, help="Skip update check")
@click.pass_context
@click.version_option(version=__version__, prog_name="ccbox")
def cli(
    ctx: click.Context, stack: str | None, build: bool, path: str, no_update_check: bool
) -> None:
    """ccbox - Run Claude Code in isolated Docker containers.

    Simply run 'ccbox' in any project directory to start.
    """
    if ctx.invoked_subcommand is not None:
        return

    _run(stack, build, path, no_update_check)


def _select_stack(
    detected_stack: LanguageStack, detected_languages: list[str]
) -> LanguageStack | None:
    """Show interactive stack selection menu."""
    console.print(Panel.fit("[bold]Stack Selection[/bold]", border_style="blue"))

    if detected_languages:
        console.print(f"[dim]Detected languages: {', '.join(detected_languages)}[/dim]\n")

    # Build options list
    options: list[tuple[str, LanguageStack, bool]] = []
    for stack in LanguageStack:
        desc, size = STACK_INFO[stack]
        is_detected = stack == detected_stack
        options.append((f"{stack.value}", stack, is_detected))

    # Get all installed images in a single Docker call (avoid N+1 queries)
    installed_images = _get_installed_ccbox_images()

    # Display options
    console.print("[bold]Available stacks:[/bold]")
    for idx, (name, stack, is_detected) in enumerate(options, 1):
        desc, size = STACK_INFO[stack]
        marker = "[green]→[/green] " if is_detected else "  "
        detected_label = " [green](detected)[/green]" if is_detected else ""
        installed = " [dim][installed][/dim]" if get_image_name(stack) in installed_images else ""
        console.print(f"  {marker}[cyan]{idx}[/cyan]. {name}{detected_label}{installed}")
        console.print(f"      [dim]{desc} (~{size}MB)[/dim]")

    console.print("\n  [dim]0[/dim]. Cancel")

    # Get user choice
    console.print()
    default_idx = next((i for i, (_, s, _) in enumerate(options, 1) if s == detected_stack), 1)

    while True:
        choice = click.prompt(
            f"Select stack [1-{len(options)}, 0 to cancel]",
            default=str(default_idx),
            show_default=False,
        )
        try:
            choice_int = int(choice)
            if choice_int == 0:
                return None
            if 1 <= choice_int <= len(options):
                return options[choice_int - 1][1]
        except ValueError:
            pass
        console.print("[red]Invalid choice. Try again.[/red]")


def _setup_git_config(config: Config) -> Config:
    """Auto-detect git config and prompt user if needed.

    Args:
        config: Current configuration.

    Returns:
        Updated configuration (may be modified and saved).
    """
    if config.git_name and config.git_email:
        return config

    name, email = get_git_config()
    if not (name or email):
        return config

    detected_name = name if name and not config.git_name else config.git_name
    detected_email = email if email and not config.git_email else config.git_email
    console.print(f"[dim]Detected git config: {detected_name} <{detected_email}>[/dim]")

    if click.confirm("Use this git config?", default=True):
        config.git_name = detected_name
        config.git_email = detected_email
        save_config(config)
    else:
        console.print("[dim]Run 'ccbox setup' to configure git credentials.[/dim]")

    return config


def _resolve_stack(
    stack_name: str | None, project_path: Path
) -> LanguageStack | None:
    """Resolve the stack to use based on user input or detection.

    Args:
        stack_name: Explicitly requested stack name, or None for auto-detection.
        project_path: Path to the project directory.

    Returns:
        Selected stack, or None if user cancelled.
    """
    detection = detect_project_type(project_path)

    if stack_name:
        return LanguageStack(stack_name)

    if image_exists(detection.recommended_stack):
        console.print(f"[dim]Using existing image: ccbox:{detection.recommended_stack.value}[/dim]")
        return detection.recommended_stack

    return _select_stack(detection.recommended_stack, detection.detected_languages)


def _ensure_image_ready(
    stack: LanguageStack, no_update_check: bool, build_only: bool
) -> bool:
    """Ensure the image is ready (built and optionally updated).

    Args:
        stack: Stack to ensure is ready.
        no_update_check: Skip update check if True.
        build_only: Only build, don't prompt for updates.

    Returns:
        True if image is ready, False on build failure.
    """
    has_image = image_exists(stack)
    update_rebuild = False

    if has_image and not no_update_check and not build_only:
        update_rebuild = _check_and_prompt_updates(stack)

    needs_build = build_only or update_rebuild or not has_image
    if needs_build:
        return build_image(stack)

    return True


def _execute_container(
    config: Config, project_path: Path, project_name: str, stack: LanguageStack
) -> None:
    """Execute the container with Claude Code.

    Args:
        config: ccbox configuration.
        project_path: Path to the project.
        project_name: Name of the project.
        stack: Stack to run.
    """
    console.print("[dim]Starting Claude Code...[/dim]\n")

    try:
        cmd = get_docker_run_cmd(config, project_path, project_name, stack)
    except ConfigPathError as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)

    try:
        subprocess.run(cmd, check=True)
    except subprocess.CalledProcessError as e:
        if e.returncode != 130:
            sys.exit(e.returncode)
    except KeyboardInterrupt:
        pass


def _run(
    stack_name: str | None,
    build_only: bool,
    path: str,
    no_update_check: bool = False,
) -> None:
    """Run Claude Code in Docker container."""
    if not check_docker():
        console.print(ERR_DOCKER_NOT_RUNNING)
        console.print("Start Docker and try again.")
        sys.exit(1)

    config = _setup_git_config(load_config())
    project_path = Path(path).resolve()
    project_name = project_path.name

    # Ensure base image exists (required for all stacks)
    if not image_exists(LanguageStack.BASE):
        console.print("[bold]First-time setup: building base image...[/bold]")
        if not build_image(LanguageStack.BASE):
            sys.exit(1)
        console.print()

    # Resolve stack
    selected_stack = _resolve_stack(stack_name, project_path)
    if selected_stack is None:
        console.print("[yellow]Cancelled.[/yellow]")
        sys.exit(0)

    console.print()
    console.print(
        Panel.fit(
            f"[bold]{project_name}[/bold] → ccbox:{selected_stack.value}",
            border_style="blue",
        )
    )

    # Ensure image is ready
    if not _ensure_image_ready(selected_stack, no_update_check, build_only):
        sys.exit(1)

    if build_only:
        console.print("[green]✓ Build complete[/green]")
        return

    _execute_container(config, project_path, project_name, selected_stack)


@cli.command()
def setup() -> None:
    """Configure git credentials (one-time setup)."""
    config = load_config()
    sys_name, sys_email = get_git_config()

    console.print("[bold]ccbox Setup[/bold]\n")

    name = click.prompt("Git name", default=config.git_name or sys_name or "")
    email = click.prompt("Git email", default=config.git_email or sys_email or "")

    config.git_name = name
    config.git_email = email
    save_config(config)

    console.print("\n[green]✓ Configuration saved[/green]")
    console.print(f"[dim]Config: {get_config_dir() / 'config.json'}[/dim]")


@cli.command()
@click.option("--stack", "-s", type=click.Choice([s.value for s in LanguageStack]), help="Stack")
@click.option("--all", "-a", "build_all", is_flag=True, help="Rebuild all installed images")
def update(stack: str | None, build_all: bool) -> None:
    """Rebuild Docker image(s) with latest Claude Code."""
    if not check_docker():
        console.print(ERR_DOCKER_NOT_RUNNING)
        sys.exit(1)

    stacks_to_build: list[LanguageStack] = []

    if stack:
        stacks_to_build.append(LanguageStack(stack))
    elif build_all:
        for s in LanguageStack:
            if image_exists(s):
                stacks_to_build.append(s)
    else:
        stacks_to_build.append(LanguageStack.BASE)

    if not stacks_to_build:
        console.print("[yellow]No images to update.[/yellow]")
        return

    for s in stacks_to_build:
        build_image(s)


def _get_installed_ccbox_images() -> set[str]:
    """Get all installed ccbox images in a single Docker call.

    Returns:
        Set of installed ccbox image names (e.g., {"ccbox:base", "ccbox:go"}).
    """
    try:
        result = subprocess.run(
            ["docker", "images", "--format", "{{.Repository}}:{{.Tag}}"],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            return set()

        # Filter to only ccbox images
        all_images = result.stdout.strip().split("\n")
        return {img for img in all_images if img.startswith("ccbox:")}
    except FileNotFoundError:
        return set()


@cli.command()
@click.option("--force", "-f", is_flag=True, help="Skip confirmation")
def clean(force: bool) -> None:
    """Remove ccbox containers and images."""
    if not check_docker():
        console.print(ERR_DOCKER_NOT_RUNNING)
        sys.exit(1)

    if not force and not click.confirm("Remove all ccbox containers and images?", default=False):
        return

    console.print("[dim]Removing containers...[/dim]")
    result = subprocess.run(
        ["docker", "ps", "-a", "--filter", "name=ccbox-", "--format", "{{.Names}}"],
        capture_output=True,
        text=True,
        check=False,
    )
    for name in result.stdout.strip().split("\n"):
        if name:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True, check=False)

    console.print("[dim]Removing images...[/dim]")
    # docker rmi -f handles non-existent images gracefully, no need to check
    for stack in LanguageStack:
        subprocess.run(
            ["docker", "rmi", "-f", get_image_name(stack)],
            capture_output=True,
            check=False,
        )

    console.print("[green]✓ Cleanup complete[/green]")


@cli.command()
@click.argument("path", default=".", type=click.Path(exists=True))
def doctor(path: str) -> None:
    """Check system status and detect project type."""
    project_path = Path(path).resolve()

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

    config = load_config()
    claude_dir = Path(os.path.expanduser(config.claude_config_dir))
    checks.append(("Claude config", claude_dir.exists(), "Run 'claude' first"))

    git_ok = bool(config.git_name and config.git_email)
    checks.append(("Git configured", git_ok, "Run 'ccbox setup'"))

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
    for stack in LanguageStack:
        if image_exists(stack):
            desc, _ = STACK_INFO[stack]
            console.print(f"  [green]ccbox:{stack.value}[/green] - {desc}")
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
    console.print("[dim]All stacks include: Python + JS/TS + CCO + lint/test tools[/dim]")


if __name__ == "__main__":  # pragma: no cover
    cli()
