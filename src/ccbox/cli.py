"""CLI commands for ccbox."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional

import click
from rich.console import Console
from rich.panel import Panel
from rich.prompt import Confirm, IntPrompt, Prompt
from rich.table import Table

from . import __version__
from .config import (
    Config,
    LanguageStack,
    RuntimeMode,
    STACK_DESCRIPTIONS,
    get_config_dir,
    get_container_name,
    get_image_name,
    load_config,
    save_config,
)
from .detector import detect_project_type
from .generator import write_build_files, write_compose_file

console = Console()


def run_command(
    cmd: list[str],
    capture: bool = False,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    """Run a shell command."""
    try:
        result = subprocess.run(
            cmd,
            capture_output=capture,
            text=True,
            check=check,
        )
        return result
    except subprocess.CalledProcessError as e:
        if capture:
            console.print(f"[red]Error:[/red] {e.stderr or e.stdout or str(e)}")
        raise


def check_docker() -> bool:
    """Check if Docker is available and running."""
    try:
        result = run_command(["docker", "info"], capture=True, check=False)
        return result.returncode == 0
    except FileNotFoundError:
        return False


def get_project_name(path: Path) -> str:
    """Get project name from directory path."""
    return path.name


@click.group()
@click.version_option(version=__version__, prog_name="ccbox")
def cli() -> None:
    """ccbox - Secure Docker environment for Claude Code CLI.

    Run Claude Code in an isolated container with project-specific access.
    """
    pass


@cli.command()
def init() -> None:
    """Interactive setup wizard for ccbox."""
    console.print(Panel.fit(
        "[bold blue]ccbox Setup Wizard[/bold blue]\n"
        "Configure your secure Claude Code environment",
        border_style="blue",
    ))

    config = load_config()

    # Step 1: Git settings
    console.print("\n[bold]1. Git Settings[/bold]")
    config.git_name = Prompt.ask(
        "  Git username",
        default=config.git_name or os.environ.get("GIT_AUTHOR_NAME", ""),
    )
    config.git_email = Prompt.ask(
        "  Git email",
        default=config.git_email or os.environ.get("GIT_AUTHOR_EMAIL", ""),
    )

    # Step 2: Performance settings
    console.print("\n[bold]2. Performance Settings[/bold]")
    config.ram_percent = IntPrompt.ask(
        "  RAM usage (%)",
        default=config.ram_percent,
    )
    config.cpu_percent = IntPrompt.ask(
        "  CPU usage (%)",
        default=config.cpu_percent,
    )

    # Step 3: Runtime mode
    console.print("\n[bold]3. Default Runtime Mode[/bold]")
    console.print("  [dim]bypass: No confirmations (faster, safe in isolated container)[/dim]")
    console.print("  [dim]safe: Standard confirmations[/dim]")
    mode_choice = Prompt.ask(
        "  Default mode",
        choices=["bypass", "safe"],
        default=config.default_mode.value,
    )
    config.default_mode = RuntimeMode(mode_choice)

    # Step 4: Default language stack
    console.print("\n[bold]4. Default Language Stack[/bold]")
    for stack in LanguageStack:
        if stack != LanguageStack.CUSTOM:
            console.print(f"  [cyan]{stack.value}[/cyan]: {STACK_DESCRIPTIONS[stack]}")

    stack_choices = [s.value for s in LanguageStack if s != LanguageStack.CUSTOM]
    stack_choice = Prompt.ask(
        "  Default stack",
        choices=stack_choices,
        default=config.default_stack.value,
    )
    config.default_stack = LanguageStack(stack_choice)

    # Step 5: Optional tools
    console.print("\n[bold]5. Optional Tools[/bold]")
    config.install_cco = Confirm.ask(
        "  Install CCO (ClaudeCodeOptimizer)?",
        default=config.install_cco,
    )
    config.install_gh = Confirm.ask(
        "  Install GitHub CLI?",
        default=config.install_gh,
    )
    config.install_gitleaks = Confirm.ask(
        "  Install Gitleaks (secret scanner)?",
        default=config.install_gitleaks,
    )

    # Step 6: Claude config directory
    console.print("\n[bold]6. Claude Configuration[/bold]")
    config.claude_config_dir = Prompt.ask(
        "  Claude config directory",
        default=config.claude_config_dir,
    )

    # Save configuration
    save_config(config)
    console.print("\n[green]Configuration saved![/green]")

    # Ask to build image
    if Confirm.ask("\nBuild Docker image now?", default=True):
        _build_image(config, config.default_stack)


def _build_image(config: Config, stack: LanguageStack) -> bool:
    """Build Docker image for a stack."""
    console.print(f"\n[bold]Building image:[/bold] {get_image_name(stack)}")

    if not check_docker():
        console.print("[red]Error:[/red] Docker is not available. Run 'ccbox doctor' for details.")
        return False

    # Generate build files
    build_dir = write_build_files(config, stack)
    console.print(f"[dim]Build directory: {build_dir}[/dim]")

    # Build image
    try:
        run_command([
            "docker", "build",
            "-t", get_image_name(stack),
            "-f", str(build_dir / "Dockerfile"),
            str(build_dir),
        ])
        console.print(f"[green]Successfully built {get_image_name(stack)}[/green]")
        return True
    except subprocess.CalledProcessError:
        console.print("[red]Failed to build image[/red]")
        return False


@cli.command()
@click.option("--bypass/--safe", "bypass_mode", default=None, help="Override default mode")
@click.option("--stack", type=click.Choice([s.value for s in LanguageStack]), help="Language stack")
@click.option("--build", is_flag=True, help="Force rebuild image before running")
@click.argument("path", default=".", type=click.Path(exists=True))
def run(
    bypass_mode: Optional[bool],
    stack: Optional[str],
    build: bool,
    path: str,
) -> None:
    """Run Claude Code in the current directory.

    PATH defaults to current directory. Claude Code will only have access
    to this directory and its contents.
    """
    config = load_config()

    if not config.git_name or not config.git_email:
        console.print("[yellow]Warning:[/yellow] Git not configured. Run 'ccbox init' first.")
        if not Confirm.ask("Continue anyway?", default=False):
            return

    project_path = Path(path).resolve()
    project_name = get_project_name(project_path)

    console.print(Panel.fit(
        f"[bold]Project:[/bold] {project_name}\n"
        f"[bold]Path:[/bold] {project_path}",
        title="ccbox",
        border_style="blue",
    ))

    # Detect or use specified stack
    if stack:
        selected_stack = LanguageStack(stack)
        console.print(f"[dim]Using specified stack: {selected_stack.value}[/dim]")
    else:
        detection = detect_project_type(project_path)
        console.print(f"\n[bold]Detected languages:[/bold] {', '.join(detection.detected_languages) or 'none'}")
        console.print(f"[bold]Recommended stack:[/bold] {detection.recommended_stack.value}")
        console.print(f"[dim]Confidence: {detection.confidence:.0%}[/dim]")

        # Ask user to confirm or change
        stack_choices = [s.value for s in LanguageStack if s != LanguageStack.CUSTOM]
        choice = Prompt.ask(
            "\nUse stack",
            choices=stack_choices,
            default=detection.recommended_stack.value,
        )
        selected_stack = LanguageStack(choice)

    # Check if image exists
    image_name = get_image_name(selected_stack)
    image_exists = _check_image_exists(image_name)

    if build or not image_exists:
        if not image_exists:
            console.print(f"[yellow]Image {image_name} not found. Building...[/yellow]")
        if not _build_image(config, selected_stack):
            return

    # Determine runtime mode
    if bypass_mode is None:
        use_bypass = config.default_mode == RuntimeMode.BYPASS
    else:
        use_bypass = bypass_mode

    mode_str = "[bold green]bypass[/bold green]" if use_bypass else "[bold yellow]safe[/bold yellow]"
    console.print(f"\n[bold]Mode:[/bold] {mode_str}")

    # Generate compose file
    build_dir = get_config_dir() / "build" / selected_stack.value
    compose_file = write_compose_file(config, project_path, project_name, selected_stack, build_dir)

    # Build claude args (entrypoint already calls claude)
    claude_args = []
    if use_bypass:
        claude_args.append("--dangerously-skip-permissions")

    # Run container
    console.print("\n[bold]Starting Claude Code...[/bold]\n")

    try:
        subprocess.run(
            [
                "docker", "compose",
                "-f", str(compose_file),
                "run", "--rm",
                "claude",
            ] + claude_args,
            check=True,
        )
    except subprocess.CalledProcessError as e:
        if e.returncode != 130:  # Ignore Ctrl+C
            console.print(f"[red]Claude Code exited with error: {e.returncode}[/red]")
    except KeyboardInterrupt:
        console.print("\n[yellow]Interrupted[/yellow]")


def _check_image_exists(image_name: str) -> bool:
    """Check if a Docker image exists."""
    try:
        result = run_command(
            ["docker", "image", "inspect", image_name],
            capture=True,
            check=False,
        )
        return result.returncode == 0
    except FileNotFoundError:
        return False


@cli.command()
@click.option("--stack", type=click.Choice([s.value for s in LanguageStack]), help="Specific stack to update")
def update(stack: Optional[str]) -> None:
    """Update Docker images to latest Claude Code version."""
    config = load_config()

    if not check_docker():
        console.print("[red]Error:[/red] Docker is not available.")
        return

    stacks_to_update: list[LanguageStack] = []

    if stack:
        stacks_to_update.append(LanguageStack(stack))
    else:
        # Find all existing images
        for s in LanguageStack:
            if s != LanguageStack.CUSTOM and _check_image_exists(get_image_name(s)):
                stacks_to_update.append(s)

    if not stacks_to_update:
        console.print("[yellow]No ccbox images found. Run 'ccbox init' first.[/yellow]")
        return

    console.print(f"[bold]Updating {len(stacks_to_update)} image(s)...[/bold]\n")

    for s in stacks_to_update:
        _build_image(config, s)


@cli.command()
@click.option("--containers", is_flag=True, help="Remove only containers")
@click.option("--images", is_flag=True, help="Remove only images")
@click.option("--all", "remove_all", is_flag=True, help="Remove everything")
@click.option("--force", "-f", is_flag=True, help="Don't ask for confirmation")
def clean(containers: bool, images: bool, remove_all: bool, force: bool) -> None:
    """Clean up ccbox containers and images."""
    if not check_docker():
        console.print("[red]Error:[/red] Docker is not available.")
        return

    # Default: clean both if nothing specified
    if not containers and not images and not remove_all:
        remove_all = True

    if remove_all:
        containers = images = True

    if not force:
        what = []
        if containers:
            what.append("containers")
        if images:
            what.append("images")
        if not Confirm.ask(f"Remove all ccbox {' and '.join(what)}?", default=False):
            return

    if containers:
        console.print("[bold]Removing containers...[/bold]")
        # Find ccbox containers
        result = run_command(
            ["docker", "ps", "-a", "--filter", "name=ccbox-", "--format", "{{.Names}}"],
            capture=True,
            check=False,
        )
        if result.stdout.strip():
            for name in result.stdout.strip().split("\n"):
                console.print(f"  Removing {name}")
                run_command(["docker", "rm", "-f", name], capture=True, check=False)

    if images:
        console.print("[bold]Removing images...[/bold]")
        for stack in LanguageStack:
            if stack != LanguageStack.CUSTOM:
                image_name = get_image_name(stack)
                if _check_image_exists(image_name):
                    console.print(f"  Removing {image_name}")
                    run_command(["docker", "rmi", "-f", image_name], capture=True, check=False)

    console.print("[green]Cleanup complete[/green]")


@cli.command("config")
@click.option("--show", is_flag=True, help="Show current configuration")
@click.option("--reset", is_flag=True, help="Reset to defaults")
@click.option("--set", "set_value", nargs=2, multiple=True, help="Set a config value (key value)")
def config_cmd(show: bool, reset: bool, set_value: tuple[tuple[str, str], ...]) -> None:
    """View or modify ccbox configuration."""
    if reset:
        if Confirm.ask("Reset all settings to defaults?", default=False):
            config = Config()
            save_config(config)
            console.print("[green]Configuration reset to defaults[/green]")
        return

    config = load_config()

    if set_value:
        for key, value in set_value:
            if hasattr(config, key):
                # Type conversion
                field_type = type(getattr(config, key))
                if field_type == bool:
                    setattr(config, key, value.lower() in ("true", "1", "yes"))
                elif field_type == int:
                    setattr(config, key, int(value))
                else:
                    setattr(config, key, value)
                console.print(f"[green]Set {key} = {value}[/green]")
            else:
                console.print(f"[red]Unknown config key: {key}[/red]")
        save_config(config)
        return

    # Show configuration (default behavior)
    table = Table(title="ccbox Configuration")
    table.add_column("Setting", style="cyan")
    table.add_column("Value", style="green")

    for field_name, value in config.model_dump().items():
        if isinstance(value, list):
            value = ", ".join(str(v) for v in value) or "(empty)"
        elif isinstance(value, dict):
            value = ", ".join(f"{k}={v}" for k, v in value.items()) or "(empty)"
        table.add_row(field_name, str(value))

    console.print(table)
    console.print(f"\n[dim]Config file: {get_config_dir() / 'config.json'}[/dim]")


@cli.command()
def doctor() -> None:
    """Check system requirements and diagnose issues."""
    console.print(Panel.fit(
        "[bold]ccbox System Check[/bold]",
        border_style="blue",
    ))

    checks: list[tuple[str, bool, str]] = []

    # Check Docker
    docker_installed = shutil.which("docker") is not None
    docker_running = check_docker()
    checks.append(("Docker installed", docker_installed, "Install Docker from docker.com"))
    checks.append(("Docker running", docker_running, "Start Docker daemon"))

    # Check disk space
    try:
        import shutil as sh
        total, used, free = sh.disk_usage("/")
        free_gb = free // (1024**3)
        has_space = free_gb >= 5
        checks.append((
            f"Disk space ({free_gb}GB free)",
            has_space,
            "Need at least 5GB free space",
        ))
    except Exception:
        checks.append(("Disk space", False, "Could not check disk space"))

    # Check Python version
    py_version = sys.version_info
    py_ok = py_version >= (3, 8)
    checks.append((
        f"Python {py_version.major}.{py_version.minor}",
        py_ok,
        "Python 3.8+ required",
    ))

    # Check Claude config directory
    config = load_config()
    claude_dir = Path(os.path.expanduser(config.claude_config_dir))
    claude_exists = claude_dir.exists()
    checks.append((
        f"Claude config ({claude_dir})",
        claude_exists,
        "Run 'claude' once to create config",
    ))

    # Check ccbox config
    ccbox_config_exists = (get_config_dir() / "config.json").exists()
    checks.append((
        "ccbox configured",
        ccbox_config_exists,
        "Run 'ccbox init' to configure",
    ))

    # Display results
    table = Table()
    table.add_column("Check", style="cyan")
    table.add_column("Status")
    table.add_column("Action", style="dim")

    all_passed = True
    for name, passed, action in checks:
        status = "[green]PASS[/green]" if passed else "[red]FAIL[/red]"
        if not passed:
            all_passed = False
        table.add_row(name, status, "" if passed else action)

    console.print(table)

    if all_passed:
        console.print("\n[green]All checks passed! ccbox is ready to use.[/green]")
    else:
        console.print("\n[yellow]Some checks failed. Please address the issues above.[/yellow]")


@cli.command()
def status() -> None:
    """Show ccbox installation status and running containers."""
    config = load_config()

    console.print(Panel.fit(
        f"[bold]ccbox v{__version__}[/bold]",
        border_style="blue",
    ))

    # Show configuration summary
    console.print("\n[bold]Configuration:[/bold]")
    console.print(f"  Git: {config.git_name} <{config.git_email}>")
    console.print(f"  Default mode: {config.default_mode.value}")
    console.print(f"  Default stack: {config.default_stack.value}")

    # Show installed images
    console.print("\n[bold]Installed Images:[/bold]")
    found_any = False
    for stack in LanguageStack:
        if stack != LanguageStack.CUSTOM:
            image_name = get_image_name(stack)
            if _check_image_exists(image_name):
                console.print(f"  [green]{image_name}[/green]")
                found_any = True

    if not found_any:
        console.print("  [dim]No images installed. Run 'ccbox init' to build.[/dim]")

    # Show running containers
    console.print("\n[bold]Running Containers:[/bold]")
    if check_docker():
        result = run_command(
            ["docker", "ps", "--filter", "name=ccbox-", "--format", "table {{.Names}}\t{{.Status}}\t{{.Ports}}"],
            capture=True,
            check=False,
        )
        if result.stdout.strip():
            console.print(result.stdout)
        else:
            console.print("  [dim]No containers running[/dim]")
    else:
        console.print("  [red]Docker not available[/red]")


@cli.command()
@click.argument("path", default=".", type=click.Path(exists=True))
def detect(path: str) -> None:
    """Detect project type and recommend language stack."""
    project_path = Path(path).resolve()

    console.print(f"[bold]Analyzing:[/bold] {project_path}\n")

    result = detect_project_type(project_path)

    table = Table(title="Detection Results")
    table.add_column("Language", style="cyan")
    table.add_column("Detected")

    for lang, detected in result.details.items():
        status = "[green]Yes[/green]" if detected else "[dim]No[/dim]"
        table.add_row(lang, status)

    console.print(table)
    console.print(f"\n[bold]Recommended stack:[/bold] {result.recommended_stack.value}")
    console.print(f"[bold]Confidence:[/bold] {result.confidence:.0%}")
    console.print(f"\n[dim]{STACK_DESCRIPTIONS.get(result.recommended_stack, '')}[/dim]")


if __name__ == "__main__":
    cli()
