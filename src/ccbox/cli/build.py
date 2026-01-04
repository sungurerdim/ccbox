"""Build operations for ccbox.

Handles Docker image building for stacks and projects.
"""

from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path
from typing import TYPE_CHECKING

from rich.console import Console

from ..config import (
    CCO_ENABLED_STACKS,
    DOCKER_COMMAND_TIMEOUT,
    STACK_DEPENDENCIES,
    LanguageStack,
    create_config,
    get_claude_config_dir,
    get_image_name,
    image_exists,
)
from ..constants import BUILD_DIR, DOCKER_BUILD_TIMEOUT
from ..deps import DepsInfo, DepsMode
from ..generator import generate_project_dockerfile, write_build_files
from ..paths import resolve_for_docker
from .cleanup import cleanup_ccbox_dangling_images

if TYPE_CHECKING:
    pass

console = Console()


def _run_cco_install(image_name: str) -> bool:
    """Run cco-install in a temporary container to update host ~/.claude.

    This installs CCO commands/agents/rules from the Docker image to the host's
    ~/.claude directory. Runs once during build, not at every container start.

    Strategy: Run as root to handle any existing root-owned directories, then
    chown everything to the host user. This solves the permission mismatch that
    occurs when directories were created by previous root operations.

    Args:
        image_name: Docker image to use for running cco-install.

    Returns:
        True if successful, False otherwise.
    """
    config = create_config()
    try:
        claude_dir = get_claude_config_dir(config)
    except Exception as e:
        console.print(f"[yellow]⚠ Could not get Claude config dir: {e}[/yellow]")
        return False

    docker_claude_dir = resolve_for_docker(claude_dir)

    console.print("[dim]Installing CCO to host ~/.claude...[/dim]")

    # Get caller's UID/GID - this is the user who should own the files
    # Works correctly whether ccbox runs on host or inside a container
    getuid = getattr(os, "getuid", None)
    getgid = getattr(os, "getgid", None)
    uid = getuid() if getuid else 1000
    gid = getgid() if getgid else 1000

    # Build docker command - run as ROOT to handle existing root-owned dirs
    # Pass UID/GID as env vars (can't rely on stat - mounted dir may be root-owned)
    docker_cmd = [
        "docker",
        "run",
        "--rm",
        "--network=none",  # No network needed
        "--memory=64m",  # Minimal RAM
        "--security-opt=no-new-privileges",
        "-v",
        f"{docker_claude_dir}:/home/node/.claude:rw",
        "-e",
        "CLAUDE_CONFIG_DIR=/home/node/.claude",
        "-e",
        "HOME=/home/node",
        "-e",
        f"TARGET_UID={uid}",
        "-e",
        f"TARGET_GID={gid}",
        "--entrypoint",
        "/bin/sh",
        image_name,
        "-c",
        # 1. Run cco-install (cco package already installed in image)
        # 2. Fix ownership using passed UID/GID (not stat - dir may be root-owned)
        "cco-install && chown -R $TARGET_UID:$TARGET_GID /home/node/.claude",
    ]

    try:
        result = subprocess.run(
            docker_cmd,
            capture_output=True,
            text=True,
            check=False,
            timeout=60,
        )

        if result.returncode == 0:
            console.print("[green]✓ CCO installed to host ~/.claude[/green]")
            return True
        else:
            # Show error but don't fail build
            stderr = result.stderr.strip()
            stdout = result.stdout.strip()
            error_msg = stderr or stdout or "unknown error"
            console.print(f"[yellow]⚠ CCO install warning: {error_msg}[/yellow]")
            return True  # Non-fatal - CCO might already be installed

    except subprocess.TimeoutExpired:
        console.print("[yellow]⚠ CCO install timed out[/yellow]")
        return True  # Non-fatal
    except Exception as e:
        console.print(f"[yellow]⚠ CCO install failed: {e}[/yellow]")
        return True  # Non-fatal


def build_image(stack: LanguageStack) -> bool:
    """Build Docker image for stack with BuildKit optimization.

    Automatically builds base image first if the stack depends on it.
    For CCO-enabled stacks, runs cco-install to update host ~/.claude.
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
        # CCO_CACHE_BUST with timestamp ensures pip also gets fresh package
        # Redirect stderr to stdout so build progress doesn't appear as errors
        subprocess.run(
            [
                "docker",
                "build",
                "-t",
                image_name,
                "-f",
                str(build_dir / "Dockerfile"),
                "--no-cache",
                "--build-arg",
                f"CCO_CACHE_BUST={int(time.time())}",
                "--progress=auto",
                str(build_dir),
            ],
            check=True,
            env=env,
            stderr=subprocess.STDOUT,
        )
        console.print(f"[green]✓ Built {image_name}[/green]")

        # Run cco-install for CCO-enabled stacks (updates host ~/.claude)
        if stack in CCO_ENABLED_STACKS:
            _run_cco_install(image_name)

        # Post-build cleanup: remove ccbox-originated dangling images only
        # Essential for preventing disk accumulation from repeated rebuilds
        cleanup_ccbox_dangling_images()

        return True
    except subprocess.CalledProcessError:
        console.print(f"[red]✗ Failed to build {image_name}[/red]")
        return False


def get_project_image_name(project_name: str, stack: LanguageStack) -> str:
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


def project_image_exists(project_name: str, stack: LanguageStack) -> bool:
    """Check if project-specific image exists."""
    image_name = get_project_image_name(project_name, stack)
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


def build_project_image(
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
    image_name = get_project_image_name(project_name, stack)
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
    build_dir = Path(BUILD_DIR) / "project" / project_name
    build_dir.mkdir(parents=True, exist_ok=True)

    dockerfile_path = build_dir / "Dockerfile"
    with open(dockerfile_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(dockerfile_content)

    env = os.environ.copy()
    env["DOCKER_BUILDKIT"] = "1"

    try:
        # Build image with project context (for copying dependency files)
        # Redirect stderr to stdout so build progress doesn't appear as errors
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
            stderr=subprocess.STDOUT,
        )
        console.print(f"[green]✓ Built {image_name}[/green]")
        return image_name
    except subprocess.CalledProcessError:
        console.print(f"[red]✗ Failed to build {image_name}[/red]")
        return None


def get_installed_ccbox_images() -> set[str]:
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


def ensure_image_ready(stack: LanguageStack, build_only: bool) -> bool:
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
