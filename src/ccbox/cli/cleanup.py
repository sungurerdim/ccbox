"""Cleanup operations for ccbox.

Handles container/image removal, pruning, and disk cleanup.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from .. import docker
from ..config import DOCKER_COMMAND_TIMEOUT, LanguageStack, get_image_name
from ..constants import BUILD_DIR, PRUNE_TIMEOUT

console = Console(force_terminal=True, legacy_windows=False)


def _get_ccbox_image_ids() -> set[str]:
    """Get all ccbox image IDs for parent chain checking.

    Returns:
        Set of ccbox image IDs, or empty set on failure.
    """
    return docker.get_image_ids("ccbox")


def _get_dangling_image_ids() -> list[str]:
    """Get all dangling image IDs.

    Returns:
        List of dangling image IDs, or empty list on failure.
    """
    return docker.get_dangling_image_ids()


def _image_has_ccbox_parent(image_id: str, ccbox_ids: set[str]) -> bool:
    """Check if an image's parent chain includes a ccbox image.

    Args:
        image_id: Docker image ID to check.
        ccbox_ids: Set of known ccbox image IDs.

    Returns:
        True if image has ccbox parent, False otherwise.
    """
    return docker.image_has_parent(image_id, ccbox_ids)


def cleanup_ccbox_dangling_images() -> int:
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
        if _image_has_ccbox_parent(image_id, ccbox_ids) and docker.remove_image(
            image_id, force=True
        ):
            removed += 1
    return removed


def prune_stale_resources(verbose: bool = False) -> dict[str, int]:
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
    containers = docker.list_containers(name_filter="ccbox-", status_filter="exited")
    for container_name in containers:
        if docker.remove_container(container_name, force=True):
            results["containers"] += 1

    # Note: We don't prune global dangling images or build cache here
    # as they may belong to other Docker projects. ccbox uses --no-cache
    # so it doesn't create intermediate cache anyway.

    # Show summary if verbose and something was pruned
    if verbose and results["containers"] > 0:
        console.print(f"[dim]Pruned: {results['containers']} stale container(s)[/dim]")

    return results


def remove_ccbox_containers() -> int:
    """Remove all ccbox containers (running + stopped).

    Returns:
        Number of containers removed.
    """
    containers = docker.list_containers(name_filter="ccbox-")
    removed = 0
    for name in containers:
        if docker.remove_container(name, force=True):
            removed += 1
    return removed


def remove_ccbox_images() -> int:
    """Remove all ccbox images (stacks + project images).

    Returns:
        Number of images removed.
    """
    removed = 0

    # Remove stack images (ccbox:base, ccbox:go, etc.)
    for stack in LanguageStack:
        if docker.remove_image(get_image_name(stack), force=True):
            removed += 1

    # Remove project images (ccbox-projectname:stack)
    images = docker.list_images(prefix="ccbox-")
    for image in images:
        if docker.remove_image(image, force=True):
            removed += 1

    return removed


def get_docker_disk_usage() -> dict[str, str]:
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


def prune_system(force: bool) -> None:
    """Prune entire Docker system (all unused resources).

    Shows detailed breakdown of what will be removed and confirms before proceeding.

    Args:
        force: Skip confirmation if True.
    """
    import click  # Import here to avoid circular dependency

    # Get disk usage for display
    usage = get_docker_disk_usage()

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
    new_usage = get_docker_disk_usage()
    console.print(
        f"[dim]Remaining: Images {new_usage['images']}, "
        f"Volumes {new_usage['volumes']}, Cache {new_usage['cache']}[/dim]"
    )


def clean_temp_files() -> int:
    """Clean up ccbox build directory.

    Returns:
        1 if temp files were removed, 0 otherwise.
    """
    # BUILD_DIR is /tmp/ccbox/build, parent is /tmp/ccbox
    ccbox_tmp = Path(BUILD_DIR).parent
    if ccbox_tmp.exists():
        shutil.rmtree(ccbox_tmp, ignore_errors=True)
        return 1
    return 0
