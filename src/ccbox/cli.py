"""CLI for ccbox - Secure Docker environment for Claude Code."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import click
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from . import __version__
from .config import (
    STACK_INFO,
    LanguageStack,
    get_config_dir,
    load_config,
    save_config,
)
from .detector import detect_project_type
from .generator import get_docker_run_cmd, write_build_files

console = Console()


def check_docker() -> bool:
    """Check if Docker is available and running."""
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


def image_exists(stack: LanguageStack) -> bool:
    """Check if Docker image exists for stack."""
    try:
        result = subprocess.run(
            ["docker", "image", "inspect", f"ccbox:{stack.value}"],
            capture_output=True,
            check=False,
        )
        return result.returncode == 0
    except FileNotFoundError:
        return False


def build_image(stack: LanguageStack) -> bool:
    """Build Docker image for stack."""
    console.print(f"[bold]Building ccbox:{stack.value}...[/bold]")

    build_dir = write_build_files(stack)

    try:
        subprocess.run(
            [
                "docker", "build",
                "-t", f"ccbox:{stack.value}",
                "-f", str(build_dir / "Dockerfile"),
                str(build_dir),
            ],
            check=True,
        )
        console.print(f"[green]✓ Built ccbox:{stack.value}[/green]")
        return True
    except subprocess.CalledProcessError:
        console.print(f"[red]✗ Failed to build ccbox:{stack.value}[/red]")
        return False


def get_git_config() -> tuple[str, str]:
    """Get git user.name and user.email from system."""
    name = email = ""
    try:
        result = subprocess.run(
            ["git", "config", "--global", "user.name"],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode == 0:
            name = result.stdout.strip()

        result = subprocess.run(
            ["git", "config", "--global", "user.email"],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode == 0:
            email = result.stdout.strip()
    except FileNotFoundError:
        pass
    return name, email


@click.group(invoke_without_command=True)
@click.option("--stack", "-s", type=click.Choice([s.value for s in LanguageStack]), help="Stack")
@click.option("--build", "-b", is_flag=True, help="Force rebuild image")
@click.option("--path", "-p", default=".", type=click.Path(exists=True), help="Project path")
@click.pass_context
@click.version_option(version=__version__, prog_name="ccbox")
def cli(ctx: click.Context, stack: str | None, build: bool, path: str) -> None:
    """ccbox - Run Claude Code in isolated Docker containers.

    Simply run 'ccbox' in any project directory to start.
    """
    # If a subcommand is invoked, skip default behavior
    if ctx.invoked_subcommand is not None:
        return

    # Default behavior: run Claude Code
    _run(stack, build, path)


def _run(stack_name: str | None, force_build: bool, path: str) -> None:
    """Run Claude Code in Docker container."""
    # Check Docker
    if not check_docker():
        console.print("[red]Error: Docker is not running.[/red]")
        console.print("Start Docker and try again.")
        sys.exit(1)

    # Load config
    config = load_config()

    # Auto-detect git config if not set
    if not config.git_name or not config.git_email:
        name, email = get_git_config()
        if name and not config.git_name:
            config.git_name = name
        if email and not config.git_email:
            config.git_email = email
        if name or email:
            save_config(config)

    # Resolve project path
    project_path = Path(path).resolve()
    project_name = project_path.name

    # Detect or use specified stack
    if stack_name:
        selected_stack = LanguageStack(stack_name)
    else:
        detection = detect_project_type(project_path)
        selected_stack = detection.recommended_stack

    console.print(
        Panel.fit(
            f"[bold]{project_name}[/bold] → ccbox:{selected_stack.value}",
            border_style="blue",
        )
    )

    # Build image if needed
    needs_build = force_build or not image_exists(selected_stack)
    if needs_build and not build_image(selected_stack):
        sys.exit(1)

    # Run container
    console.print("[dim]Starting Claude Code...[/dim]\n")

    cmd = get_docker_run_cmd(config, project_path, project_name, selected_stack)

    try:
        subprocess.run(cmd, check=True)
    except subprocess.CalledProcessError as e:
        if e.returncode != 130:  # Ignore Ctrl+C
            sys.exit(e.returncode)
    except KeyboardInterrupt:
        pass


@cli.command()
def setup() -> None:
    """Configure git credentials (one-time setup)."""
    config = load_config()

    # Try to get from git config
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
@click.option("--all", "-a", "build_all", is_flag=True, help="Rebuild all existing images")
def update(stack: str | None, build_all: bool) -> None:
    """Rebuild Docker image(s) with latest Claude Code."""
    if not check_docker():
        console.print("[red]Error: Docker is not running.[/red]")
        sys.exit(1)

    stacks_to_build: list[LanguageStack] = []

    if stack:
        stacks_to_build.append(LanguageStack(stack))
    elif build_all:
        # Rebuild all existing images
        for s in LanguageStack:
            if image_exists(s):
                stacks_to_build.append(s)
    else:
        # Default: rebuild python stack (most common)
        stacks_to_build.append(LanguageStack.PYTHON)

    if not stacks_to_build:
        console.print("[yellow]No images to update.[/yellow]")
        return

    for s in stacks_to_build:
        build_image(s)


@cli.command()
@click.option("--images", "-i", is_flag=True, help="Remove images only")
@click.option("--force", "-f", is_flag=True, help="Skip confirmation")
def clean(images: bool, force: bool) -> None:
    """Remove ccbox containers and images."""
    if not check_docker():
        console.print("[red]Error: Docker is not running.[/red]")
        sys.exit(1)

    if not force and not click.confirm("Remove all ccbox containers and images?", default=False):
        return

    # Remove containers
    if not images:
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

    # Remove images
    console.print("[dim]Removing images...[/dim]")
    for stack in LanguageStack:
        if image_exists(stack):
            subprocess.run(
                ["docker", "rmi", "-f", f"ccbox:{stack.value}"],
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

    # Docker
    docker_ok = check_docker()
    checks.append(("Docker running", docker_ok, "Start Docker"))

    # Disk space
    try:
        _, _, free = shutil.disk_usage("/")
        free_gb = free // (1024**3)
        checks.append((f"Disk space ({free_gb}GB)", free_gb >= 5, "Need 5GB+"))
    except Exception:
        checks.append(("Disk space", False, "Cannot check"))

    # Python
    py_ok = sys.version_info >= (3, 8)
    checks.append((f"Python {sys.version_info.major}.{sys.version_info.minor}", py_ok, "Need 3.8+"))

    # Claude config
    config = load_config()
    claude_dir = Path(os.path.expanduser(config.claude_config_dir))
    checks.append(("Claude config", claude_dir.exists(), "Run 'claude' first"))

    # Git config
    git_ok = bool(config.git_name and config.git_email)
    checks.append(("Git configured", git_ok, "Run 'ccbox setup'"))

    # Display checks
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
            desc, size = STACK_INFO[stack]
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
    console.print("\n[dim]Usage: ccbox --stack=python[/dim]")


if __name__ == "__main__":
    cli()
