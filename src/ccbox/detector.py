"""Project type detection for automatic language stack selection."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .config import LanguageStack


@dataclass
class DetectionResult:
    """Result of project detection."""

    recommended_stack: LanguageStack
    detected_languages: list[str] = field(default_factory=list)


# File patterns for language detection
LANGUAGE_PATTERNS: dict[str, list[str]] = {
    "python": ["pyproject.toml", "setup.py", "requirements.txt", "Pipfile", "poetry.lock"],
    "node": ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"],
    "go": ["go.mod", "go.sum"],
    "rust": ["Cargo.toml", "Cargo.lock"],
    "java": ["pom.xml", "build.gradle", "build.gradle.kts"],
}


def detect_project_type(directory: Path) -> DetectionResult:
    """Detect the project type based on files in the directory."""
    detected: list[str] = []

    for lang, patterns in LANGUAGE_PATTERNS.items():
        for pattern in patterns:
            if (directory / pattern).exists():
                detected.append(lang)
                break

    # Determine recommended stack
    stack = _determine_stack(detected)

    return DetectionResult(
        recommended_stack=stack,
        detected_languages=detected,
    )


def _determine_stack(languages: list[str]) -> LanguageStack:
    """Determine the best stack based on detected languages."""
    has_python = "python" in languages
    has_node = "node" in languages
    has_go = "go" in languages
    has_rust = "rust" in languages
    has_java = "java" in languages

    # Multiple compiled languages -> FULL
    compiled_count = sum([has_go, has_rust, has_java])
    if compiled_count >= 2:
        return LanguageStack.FULL

    # Single compiled language takes priority
    if has_go:
        return LanguageStack.GO
    if has_rust:
        return LanguageStack.RUST
    if has_java:
        return LanguageStack.JAVA

    # Node + Python -> WEB (fullstack)
    if has_node and has_python:
        return LanguageStack.WEB

    # Python only, Node only, or nothing -> BASE
    # (BASE includes Python + Node tools anyway)
    return LanguageStack.BASE
