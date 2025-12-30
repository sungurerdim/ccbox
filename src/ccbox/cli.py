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
    create_config,
    get_image_name,
    image_exists,
)
from .deps import DepsInfo, DepsMode, detect_dependencies
from .detector import detect_project_type
from .generator import generate_project_dockerfile, get_docker_run_cmd, write_build_files

console = Console()

# Constants
DOCKER_STARTUP_TIMEOUT_SECONDS = 30
DOCKER_CHECK_INTERVAL_SECONDS = 5
ERR_DOCKER_NOT_RUNNING = "[red]Error: Docker is not running.[/red]"

# Timeout constants (seconds)
DOCKER_BUILD_TIMEOUT = 600  # 10 min for image builds
DOCKER_COMMAND_TIMEOUT = 30  # 30s for docker info/inspect/version
PRUNE_TIMEOUT = 60  # 60s for prune operations

# Validation constants
MAX_PROMPT_LENGTH = 5000  # Maximum characters for --prompt parameter

# Prune settings
PRUNE_CACHE_AGE = "168h"  # 7 days - keep recent build cache


def _check_docker_status() -> bool:
    """Check if Docker daemon is responsive."""
    try:
        result = subprocess.run(
            ["docker", "info"],
            capture_output=True,
            text=True,
            check=False,
            timeout=DOCKER_COMMAND_TIMEOUT,
        )
        return result.returncode == 0
    except FileNotFoundError:
        console.print("[dim]Docker not found in PATH[/dim]", highlight=False)
        return False
    except subprocess.TimeoutExpired:
        console.print("[dim]Docker check timed out[/dim]", highlight=False)
        return False


def _start_docker_desktop() -> bool:
    """Attempt to start Docker Desktop based on platform."""
    system = platform.system()

    if system == "Windows":
        result = subprocess.run(
            ["docker", "desktop", "start"],
            capture_output=True,
            check=False,
            timeout=DOCKER_COMMAND_TIMEOUT,
        )
        if result.returncode == 0:
            return True
        docker_path = Path(os.environ.get("PROGRAMFILES", "C:\\Program Files"))
        docker_exe = docker_path / "Docker" / "Docker" / "Docker Desktop.exe"
        if docker_exe.exists():
            try:
                subprocess.Popen([str(docker_exe)], start_new_session=True)
                return True
            except (OSError, PermissionError):
                return False
    elif system == "Darwin":
        subprocess.run(
            ["open", "-a", "Docker"],
            capture_output=True,
            check=False,
            timeout=DOCKER_COMMAND_TIMEOUT,
        )
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


def _get_ccbox_image_ids() -> set[str]:
    """Get all ccbox image IDs for parent chain checking.

    Returns:
        Set of ccbox image IDs, or empty set on failure.
    """
    try:
        result = subprocess.run(
            ["docker", "images", "--format", "{{.ID}}", "ccbox"],
            capture_output=True,
            text=True,
            check=False,
            timeout=DOCKER_COMMAND_TIMEOUT,
        )
        if result.returncode != 0:
            return set()
        ids = set(result.stdout.strip().split("\n"))
        return ids - {""}  # Remove empty string if present
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return set()


def _get_dangling_image_ids() -> list[str]:
    """Get all dangling image IDs.

    Returns:
        List of dangling image IDs, or empty list on failure.
    """
    try:
        result = subprocess.run(
            ["docker", "images", "-f", "dangling=true", "-q"],
            capture_output=True,
            text=True,
            check=False,
            timeout=DOCKER_COMMAND_TIMEOUT,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return []
        return [i for i in result.stdout.strip().split("\n") if i]
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return []


def _image_has_ccbox_parent(image_id: str, ccbox_ids: set[str]) -> bool:
    """Check if an image's parent chain includes a ccbox image.

    Args:
        image_id: Docker image ID to check.
        ccbox_ids: Set of known ccbox image IDs.

    Returns:
        True if image has ccbox parent, False otherwise.
    """
    try:
        result = subprocess.run(
            ["docker", "history", "--no-trunc", "-q", image_id],
            capture_output=True,
            text=True,
            check=False,
            timeout=DOCKER_COMMAND_TIMEOUT,
        )
        if result.returncode != 0:
            return False
        history_ids = set(result.stdout.strip().split("\n"))
        return bool(history_ids & ccbox_ids)  # Intersection check
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False


def _cleanup_ccbox_dangling_images() -> int:
    """Post-build cleanup: remove ONLY ccbox-originated dangling images.

    Called after each image build to prevent disk accumulation from rebuilds.
    This is NOT dead code - it's essential for cleanup when users don't run
    `ccbox prune` manually.

    Safety mechanism:
        Only removes dangling images whose parent layer chain includes a ccbox
        image ID. Non-ccbox dangling images are left untouched.

    Returns:
        Number of ccbox dangling images removed.
    """
    ccbox_ids = _get_ccbox_image_ids()
    if not ccbox_ids:
        return 0

    dangling_ids = _get_dangling_image_ids()
    if not dangling_ids:
        return 0

    removed = 0
    for image_id in dangling_ids:
        if _image_has_ccbox_parent(image_id, ccbox_ids):
            try:
                result = subprocess.run(
                    ["docker", "rmi", "-f", image_id],
                    capture_output=True,
                    check=False,
                    timeout=DOCKER_COMMAND_TIMEOUT,
                )
                if result.returncode == 0:
                    removed += 1
            except (subprocess.TimeoutExpired, FileNotFoundError):
                continue
    return removed


def _prune_stale_resources(verbose: bool = False) -> dict[str, int]:
    """Prune stale ccbox Docker resources before run.

    Only cleans ccbox-specific resources - does NOT touch other Docker projects.

    Args:
        verbose: Show prune output if True.

    Returns:
        Dict with counts of pruned resources by type.
    """
    results: dict[str, int] = {"containers": 0}

    # Remove stopped ccbox containers (crash recovery - shouldn't exist due to --rm)
    # Only targets containers with ccbox- prefix
    try:
        result = subprocess.run(
            ["docker", "ps", "-a", "--filter", "name=ccbox-", "--filter", "status=exited", "-q"],
            capture_output=True,
            text=True,
            check=False,
            timeout=DOCKER_COMMAND_TIMEOUT,
        )
        container_ids = [c for c in result.stdout.strip().split("\n") if c]
        if container_ids:
            subprocess.run(
                ["docker", "rm", "-f", *container_ids],
                capture_output=True,
                check=False,
                timeout=DOCKER_COMMAND_TIMEOUT,
            )
            results["containers"] = len(container_ids)
    except (subprocess.TimeoutExpired, FileNotFoundError):
        # Log warning for debugging in CI/CD environments
        console.print("[dim]Docker cleanup skipped (timeout or not found)[/dim]")

    # Note: We don't prune global dangling images or build cache here
    # as they may belong to other Docker projects. ccbox uses --no-cache
    # so it doesn't create intermediate cache anyway.

    # Show summary if verbose and something was pruned
    if verbose and results["containers"] > 0:
        console.print(f"[dim]Pruned: {results['containers']} stale container(s)[/dim]")

    return results


def _remove_ccbox_containers() -> int:
    """Remove all ccbox containers (running + stopped).

    Returns:
        Number of containers removed.
    """
    try:
        result = subprocess.run(
            ["docker", "ps", "-a", "--filter", "name=ccbox-", "--format", "{{.Names}}"],
            capture_output=True,
            text=True,
            check=False,
            timeout=DOCKER_COMMAND_TIMEOUT,
        )
        removed = 0
        for name in result.stdout.strip().split("\n"):
            if name:
                rm_result = subprocess.run(
                    ["docker", "rm", "-f", name],
                    capture_output=True,
                    check=False,
                    timeout=DOCKER_COMMAND_TIMEOUT,
                )
                if rm_result.returncode == 0:
                    removed += 1
        return removed
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return 0


def _remove_ccbox_images() -> int:
    """Remove all ccbox images (stacks + project images).

    Returns:
        Number of images removed.
    """
    removed = 0

    # Remove stack images (ccbox:base, ccbox:go, etc.)
    for stack in LanguageStack:
        try:
            result = subprocess.run(
                ["docker", "rmi", "-f", get_image_name(stack)],
                capture_output=True,
                check=False,
                timeout=DOCKER_COMMAND_TIMEOUT,
            )
            if result.returncode == 0:
                removed += 1
        except (subprocess.TimeoutExpired, FileNotFoundError):
            continue

    # Remove project images (ccbox-projectname:stack)
    try:
        images_result = subprocess.run(
            ["docker", "images", "--format", "{{.Repository}}:{{.Tag}}"],
            capture_output=True,
            text=True,
            check=False,
            timeout=DOCKER_COMMAND_TIMEOUT,
        )
        if images_result.returncode == 0:
            for image in images_result.stdout.strip().split("\n"):
                if image.startswith("ccbox-"):
                    rmi_result = subprocess.run(
                        ["docker", "rmi", "-f", image],
                        capture_output=True,
                        check=False,
                        timeout=DOCKER_COMMAND_TIMEOUT,
                    )
                    if rmi_result.returncode == 0:
                        removed += 1
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass

    return removed


def build_image(stack: LanguageStack) -> bool:
    """Build Docker image for stack with BuildKit optimization.

    Automatically builds base image first if the stack depends on it.
    CCO files are installed inside the image at /opt/cco/ during build.
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
        # Disable all Docker cache to ensure fresh builds (Claude Code + CCO updates)
        subprocess.run(
            [
                "docker",
                "build",
                "-t",
                image_name,
                "-f",
                str(build_dir / "Dockerfile"),
                "--no-cache",
                "--progress=auto",
                str(build_dir),
            ],
            check=True,
            env=env,
        )
        console.print(f"[green]✓ Built {image_name}[/green]")

        # Post-build cleanup: remove ccbox-originated dangling images only
        # Essential for preventing disk accumulation from repeated rebuilds
        _cleanup_ccbox_dangling_images()

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
            timeout=DOCKER_COMMAND_TIMEOUT,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except FileNotFoundError:
        console.print("[dim]Git not found in PATH[/dim]", highlight=False)
    except subprocess.TimeoutExpired:
        console.print(f"[dim]Git config {key} timed out[/dim]", highlight=False)
    return ""


def get_git_config() -> tuple[str, str]:
    """Get git user.name and user.email from system."""
    return _get_git_config_value("user.name"), _get_git_config_value("user.email")


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
) -> None:
    """ccbox - Run Claude Code in isolated Docker containers.

    Simply run 'ccbox' in any project directory to start.
    """
    if ctx.invoked_subcommand is not None:
        return

    # Change directory if --chdir/-C specified (like git -C)
    if chdir:
        os.chdir(chdir)

    # Validate prompt parameter
    if prompt is not None:
        prompt = prompt.strip()
        if not prompt:
            console.print("[red]Error: --prompt cannot be empty or whitespace-only[/red]")
            sys.exit(1)
        if len(prompt) > MAX_PROMPT_LENGTH:
            console.print(
                f"[red]Error: --prompt must be {MAX_PROMPT_LENGTH} characters or less[/red]"
            )
            sys.exit(1)

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
    )


def _validate_deps_choice(choice: str, max_option: int) -> int | None:
    """Validate user's dependency installation choice.

    Args:
        choice: User input string.
        max_option: Maximum valid option number.

    Returns:
        Validated choice as int, or None if invalid.
    """
    try:
        choice_int = int(choice)
        if 1 <= choice_int <= max_option:
            return choice_int
    except ValueError:
        pass
    return None


def _prompt_deps(deps_list: list[DepsInfo]) -> DepsMode:
    """Prompt user for dependency installation preference.

    Args:
        deps_list: List of detected dependencies.

    Returns:
        Selected DepsMode.
    """
    console.print(Panel.fit("[bold]Dependencies Detected[/bold]", border_style="cyan"))

    # Show detected package managers
    for deps in deps_list:
        files_str = ", ".join(deps.files[:3])
        if len(deps.files) > 3:
            files_str += f" (+{len(deps.files) - 3} more)"
        console.print(f"  [cyan]{deps.name}[/cyan]: {files_str}")

    console.print()

    # Check if any have dev dependencies
    has_dev = any(d.has_dev for d in deps_list)

    if has_dev:
        console.print("[bold]Install dependencies?[/bold]")
        console.print("  [cyan]1[/cyan]. All (including dev/test)")
        console.print("  [cyan]2[/cyan]. Production only")
        console.print("  [cyan]3[/cyan]. Skip")
        console.print()

        while True:
            choice = click.prompt("Select [1-3]", default="1", show_default=False)
            validated = _validate_deps_choice(choice, 3)
            if validated == 1:
                return DepsMode.ALL
            if validated == 2:
                return DepsMode.PROD
            if validated == 3:
                return DepsMode.SKIP
            console.print("[red]Invalid choice. Try again.[/red]")
    else:
        # No dev distinction - just ask yes/no
        if click.confirm("Install dependencies?", default=True):
            return DepsMode.ALL
        return DepsMode.SKIP


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


def _setup_git_config() -> Config:
    """Create config with git settings from host.

    Returns:
        Config with git name/email from host's git config.
    """
    config = create_config()
    name, email = get_git_config()

    if name:
        config.git_name = name
    if email:
        config.git_email = email

    if name or email:
        console.print(f"[dim]Git config: {name or '(none)'} <{email or '(none)'}>[/dim]")

    return config


def _resolve_stack(
    stack_name: str | None,
    project_path: Path,
    *,
    skip_if_image_exists: bool = False,
    unattended: bool = False,
) -> LanguageStack | None:
    """Resolve the stack to use based on user input or detection.

    Args:
        stack_name: Explicitly requested stack name, "auto", or None for interactive.
        project_path: Path to the project directory.
        skip_if_image_exists: If True, skip selection when stack image exists.
        unattended: If True, skip interactive prompts and use detected stack.

    Returns:
        Selected stack, or None if user cancelled.
    """
    detection = detect_project_type(project_path)

    # --stack=auto or unattended mode: use detected stack directly, no prompt
    if stack_name == "auto" or unattended:
        return detection.recommended_stack

    # Explicit stack specified
    if stack_name:
        return LanguageStack(stack_name)

    # No --stack: interactive menu (or skip if image exists)
    if skip_if_image_exists and image_exists(detection.recommended_stack):
        return detection.recommended_stack

    return _select_stack(detection.recommended_stack, detection.detected_languages)


def _ensure_image_ready(stack: LanguageStack, build_only: bool) -> bool:
    """Ensure the image is ready (built if needed).

    Args:
        stack: Stack to ensure is ready.
        build_only: Only build, don't run container.

    Returns:
        True if image is ready, False on build failure.
    """
    needs_build = build_only or not image_exists(stack)
    if needs_build:
        return build_image(stack)

    return True


def _execute_container(
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
        )
    except ConfigPathError as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)

    try:
        # Stream mode (-dd): close stdin for watch-only (no user input)
        stdin = subprocess.DEVNULL if debug >= 2 else None
        subprocess.run(cmd, check=True, stdin=stdin)
    except subprocess.CalledProcessError as e:
        if e.returncode != 130:
            sys.exit(e.returncode)
    except KeyboardInterrupt:
        pass


def _get_project_image_name(project_name: str, stack: LanguageStack) -> str:
    """Get project-specific image name.

    Docker image tags have length limits (128 chars max for tag part).
    This function sanitizes and validates the project name.
    """
    # Sanitize project name for Docker tag
    safe_name = "".join(c if c.isalnum() or c in "-_" else "-" for c in project_name.lower())
    # Docker tag limit is 128 chars; ccbox- prefix is 6 chars, :stack is ~10 chars max
    max_name_len = 110
    if len(safe_name) > max_name_len:
        safe_name = safe_name[:max_name_len]
    return f"ccbox-{safe_name}:{stack.value}"


def _project_image_exists(project_name: str, stack: LanguageStack) -> bool:
    """Check if project-specific image exists."""
    image_name = _get_project_image_name(project_name, stack)
    try:
        result = subprocess.run(
            ["docker", "image", "inspect", image_name],
            capture_output=True,
            check=False,
            timeout=DOCKER_COMMAND_TIMEOUT,
        )
        return result.returncode == 0
    except FileNotFoundError:
        console.print("[dim]Docker not found in PATH[/dim]", highlight=False)
        return False
    except subprocess.TimeoutExpired:
        console.print(f"[dim]Docker image check timed out: {image_name}[/dim]", highlight=False)
        return False


def _build_project_image(
    project_path: Path,
    project_name: str,
    stack: LanguageStack,
    deps_list: list[DepsInfo],
    deps_mode: DepsMode,
) -> str | None:
    """Build project-specific image with dependencies.

    Args:
        project_path: Path to project directory.
        project_name: Name of the project.
        stack: Base stack to build on.
        deps_list: List of detected dependencies.
        deps_mode: Dependency installation mode.

    Returns:
        Image name if successful, None otherwise.
    """
    image_name = _get_project_image_name(project_name, stack)
    base_image = get_image_name(stack)

    console.print("\n[bold]Building project image with dependencies...[/bold]")

    # Generate Dockerfile
    dockerfile_content = generate_project_dockerfile(
        base_image=base_image,
        deps_list=deps_list,
        deps_mode=deps_mode,
        project_path=project_path,
    )

    # Write to temp build directory
    build_dir = Path("/tmp/ccbox/build/project") / project_name
    build_dir.mkdir(parents=True, exist_ok=True)

    dockerfile_path = build_dir / "Dockerfile"
    with open(dockerfile_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(dockerfile_content)

    env = os.environ.copy()
    env["DOCKER_BUILDKIT"] = "1"

    try:
        # Build image with project context (for copying dependency files)
        subprocess.run(
            [
                "docker",
                "build",
                "-t",
                image_name,
                "-f",
                str(dockerfile_path),
                "--progress=auto",
                str(project_path),
            ],
            check=True,
            env=env,
            timeout=DOCKER_BUILD_TIMEOUT,
        )
        console.print(f"[green]✓ Built {image_name}[/green]")
        return image_name
    except subprocess.CalledProcessError:
        console.print(f"[red]✗ Failed to build {image_name}[/red]")
        return None


def _try_run_existing_image(
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
) -> bool:
    """Try to run using existing project image. Returns True if handled."""
    if not _project_image_exists(project_name, stack):
        return False

    project_image = _get_project_image_name(project_name, stack)
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

    _execute_container(
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
    )
    return True


def _build_and_run(
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
    if not _ensure_image_ready(selected_stack, build_only=False):
        sys.exit(1)

    # Build project-specific image if deps requested
    built_project_image: str | None = None
    if resolved_deps_mode != DepsMode.SKIP and deps_list:
        built_project_image = _build_project_image(
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

    _execute_container(
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
    )


def _run(
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
) -> None:
    """Run Claude Code in Docker container."""
    if not check_docker():
        console.print(ERR_DOCKER_NOT_RUNNING)
        console.print("Start Docker and try again.")
        sys.exit(1)

    # Pre-run cleanup: remove stale resources (crashed containers, dangling images, old cache)
    if prune:
        _prune_stale_resources(verbose=debug > 0)

    # Validate project path early
    project_path = Path(path).resolve()
    if not project_path.exists():
        console.print(f"[red]Error: Project path does not exist: {project_path}[/red]")
        sys.exit(1)
    if not project_path.is_dir():
        console.print(f"[red]Error: Project path must be a directory: {project_path}[/red]")
        sys.exit(1)

    config = _setup_git_config()
    project_name = project_path.name

    # Detect recommended stack first (no prompt yet)
    detection = detect_project_type(project_path)
    if stack_name and stack_name != "auto":
        initial_stack = LanguageStack(stack_name)
    else:
        initial_stack = detection.recommended_stack

    # Phase 1: Try existing project image (skip prompts if found)
    if _try_run_existing_image(
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
            resolved_deps_mode = _prompt_deps(deps_list)
            console.print()

    # Now resolve stack (with selection menu if needed)
    selected_stack = _resolve_stack(
        stack_name, project_path, skip_if_image_exists=True, unattended=unattended
    )
    if selected_stack is None:
        console.print("[yellow]Cancelled.[/yellow]")
        sys.exit(0)

    # Phase 3: Build and run
    _build_and_run(
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
    )


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
            timeout=DOCKER_COMMAND_TIMEOUT,
        )
        if result.returncode != 0:
            return set()

        # Filter to only ccbox images
        all_images = result.stdout.strip().split("\n")
        return {img for img in all_images if img.startswith("ccbox:")}
    except FileNotFoundError:
        console.print("[dim]Docker not found in PATH[/dim]", highlight=False)
        return set()
    except subprocess.TimeoutExpired:
        console.print("[dim]Docker images list timed out[/dim]", highlight=False)
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
    containers_removed = _remove_ccbox_containers()

    console.print("[dim]Removing images...[/dim]")
    images_removed = _remove_ccbox_images()

    console.print("[green]✓ Cleanup complete[/green]")
    if containers_removed or images_removed:
        parts = []
        if containers_removed:
            parts.append(f"{containers_removed} container(s)")
        if images_removed:
            parts.append(f"{images_removed} image(s)")
        console.print(f"[dim]Removed: {', '.join(parts)}[/dim]")


def _prune_system(force: bool) -> None:
    """Prune entire Docker system (all unused resources).

    Shows detailed breakdown of what will be removed and confirms before proceeding.

    Args:
        force: Skip confirmation if True.
    """
    # Get disk usage for display
    usage = _get_docker_disk_usage()

    if not force:
        console.print(Panel.fit("[bold yellow]Docker System Cleanup[/bold yellow]"))
        console.print()
        console.print("[yellow]This will remove ALL unused Docker resources:[/yellow]")
        console.print()

        table = Table(show_header=True, header_style="bold", box=None)
        table.add_column("Resource", style="cyan")
        table.add_column("What gets removed")
        table.add_column("Reclaimable", justify="right", style="green")

        table.add_row(
            "Containers",
            "All stopped containers",
            usage["containers"],
        )
        table.add_row(
            "Images",
            "Dangling images (<none>:<none>)",
            usage["images"],
        )
        table.add_row(
            "Volumes",
            "Unused volumes (not attached to containers)",
            usage["volumes"],
        )
        table.add_row(
            "Build Cache",
            "All cached build layers",
            usage["cache"],
        )

        console.print(table)
        console.print()
        console.print(
            "[red bold]⚠ WARNING:[/red bold] This affects ALL Docker projects, not just ccbox!"
        )
        console.print("[dim]Running containers and their images/volumes will NOT be removed.[/dim]")
        console.print()

        if not click.confirm("Continue with full system cleanup?", default=False):
            console.print("[dim]Cancelled.[/dim]")
            return

    console.print()
    console.print("[bold]Cleaning Docker system...[/bold]")

    # 1. Remove stopped containers
    console.print("[dim]Removing stopped containers...[/dim]")
    subprocess.run(
        ["docker", "container", "prune", "-f"],
        capture_output=True,
        check=False,
        timeout=PRUNE_TIMEOUT,
    )

    # 2. Remove dangling images
    console.print("[dim]Removing dangling images...[/dim]")
    subprocess.run(
        ["docker", "image", "prune", "-f"],
        capture_output=True,
        check=False,
        timeout=PRUNE_TIMEOUT,
    )

    # 3. Remove unused volumes
    console.print("[dim]Removing unused volumes...[/dim]")
    subprocess.run(
        ["docker", "volume", "prune", "-f"],
        capture_output=True,
        check=False,
        timeout=PRUNE_TIMEOUT,
    )

    # 4. Remove build cache
    console.print("[dim]Removing build cache...[/dim]")
    subprocess.run(
        ["docker", "builder", "prune", "-f", "--all"],
        capture_output=True,
        check=False,
        timeout=PRUNE_TIMEOUT,
    )

    # Show final disk usage
    console.print()
    console.print("[green]✓ System cleanup complete[/green]")

    # Get new usage to show what was freed
    new_usage = _get_docker_disk_usage()
    console.print(
        f"[dim]Remaining: Images {new_usage['images']}, "
        f"Volumes {new_usage['volumes']}, Cache {new_usage['cache']}[/dim]"
    )


def _get_docker_disk_usage() -> dict[str, str]:
    """Get Docker disk usage for display.

    Returns:
        Dict with size strings for containers, images, volumes, and cache.
    """
    usage: dict[str, str] = {"containers": "?", "images": "?", "volumes": "?", "cache": "?"}
    try:
        result = subprocess.run(
            ["docker", "system", "df", "--format", "{{.Type}}\t{{.Size}}\t{{.Reclaimable}}"],
            capture_output=True,
            text=True,
            check=False,
            timeout=DOCKER_COMMAND_TIMEOUT,
        )
        if result.returncode == 0:
            for line in result.stdout.strip().split("\n"):
                parts = line.split("\t")
                if len(parts) >= 3:
                    resource_type = parts[0].lower()
                    reclaimable = parts[2]
                    if "images" in resource_type:
                        usage["images"] = reclaimable
                    elif "containers" in resource_type:
                        usage["containers"] = reclaimable
                    elif "volumes" in resource_type:
                        usage["volumes"] = reclaimable
                    elif "build" in resource_type:
                        usage["cache"] = reclaimable
    except (subprocess.TimeoutExpired, FileNotFoundError):
        # Disk usage unavailable - return empty dict, caller handles gracefully
        console.print("[dim]Docker disk usage unavailable (timeout or not found)[/dim]")
    return usage


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

    if system:
        _prune_system(force)
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
    containers_removed = _remove_ccbox_containers()

    # 2. Remove ALL ccbox images (stacks + project images)
    console.print("[dim]Removing images...[/dim]")
    images_removed = _remove_ccbox_images()

    # Note: We intentionally do NOT prune global dangling images or build cache
    # as they may belong to other Docker projects. ccbox uses --no-cache anyway,
    # so it doesn't create intermediate build cache.

    # 3. Clean up ccbox build directory
    console.print("[dim]Removing temp files...[/dim]")
    build_dir = Path("/tmp/ccbox")
    tmpdir_removed = 0
    if build_dir.exists():
        shutil.rmtree(build_dir, ignore_errors=True)
        tmpdir_removed = 1

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
    console.print("[dim]All stacks include: Python + Node.js + lint/test tools[/dim]")
    console.print("[dim]All except 'minimal' include CCO[/dim]")


if __name__ == "__main__":  # pragma: no cover
    cli()
