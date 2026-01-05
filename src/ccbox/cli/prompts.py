"""User prompts and selection for ccbox.

Handles interactive prompts for stack selection, dependency installation, etc.
"""

from __future__ import annotations

from pathlib import Path

import click
from rich.console import Console
from rich.panel import Panel

from ..config import (
    STACK_INFO,
    Config,
    LanguageStack,
    create_config,
    get_image_name,
    image_exists,
)
from ..deps import DepsInfo, DepsMode
from ..detector import detect_project_type
from .build import get_installed_ccbox_images
from .utils import get_git_config

console = Console(force_terminal=True, legacy_windows=False)


def validate_deps_choice(choice: str, max_option: int) -> int | None:
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


def prompt_deps(deps_list: list[DepsInfo]) -> DepsMode:
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
            validated = validate_deps_choice(choice, 3)
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


def select_stack(
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
    installed_images = get_installed_ccbox_images()

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


def setup_git_config() -> Config:
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


def resolve_stack(
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

    return select_stack(detection.recommended_stack, detection.detected_languages)
