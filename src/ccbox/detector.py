"""Project type detection for automatic language stack selection."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from .config import LanguageStack


@dataclass
class DetectionResult:
    """Result of project detection."""

    recommended_stack: LanguageStack
    detected_languages: list[str] = field(default_factory=list)
    confidence: float = 0.0  # 0.0 to 1.0
    details: dict[str, bool] = field(default_factory=dict)


# File patterns for language detection
LANGUAGE_PATTERNS: dict[str, list[str]] = {
    "node": [
        "package.json",
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        ".nvmrc",
        "tsconfig.json",
        ".npmrc",
    ],
    "python": [
        "pyproject.toml",
        "setup.py",
        "requirements.txt",
        "Pipfile",
        "poetry.lock",
        ".python-version",
        "tox.ini",
        "setup.cfg",
    ],
    "go": [
        "go.mod",
        "go.sum",
        "go.work",
    ],
    "rust": [
        "Cargo.toml",
        "Cargo.lock",
    ],
    "java": [
        "pom.xml",
        "build.gradle",
        "build.gradle.kts",
        "settings.gradle",
        ".mvn",
        "gradlew",
    ],
    "dotnet": [
        "*.csproj",
        "*.fsproj",
        "*.sln",
        "global.json",
        "nuget.config",
    ],
}


def _check_glob_pattern(directory: Path, pattern: str) -> bool:
    """Check if a glob pattern matches any files in the directory."""
    if "*" in pattern:
        return len(list(directory.glob(pattern))) > 0
    return (directory / pattern).exists()


def detect_project_type(directory: Path) -> DetectionResult:
    """
    Detect the project type based on files in the directory.

    Args:
        directory: Path to the project directory

    Returns:
        DetectionResult with recommended stack and detected languages
    """
    detected: dict[str, bool] = {}

    for lang, patterns in LANGUAGE_PATTERNS.items():
        for pattern in patterns:
            if _check_glob_pattern(directory, pattern):
                detected[lang] = True
                break
        else:
            detected[lang] = False

    languages = [lang for lang, found in detected.items() if found]

    # Determine recommended stack based on detected languages
    recommended = _determine_stack(languages)

    # Calculate confidence
    confidence = _calculate_confidence(languages, directory)

    return DetectionResult(
        recommended_stack=recommended,
        detected_languages=languages,
        confidence=confidence,
        details=detected,
    )


def _determine_stack(languages: list[str]) -> LanguageStack:
    """Determine the best stack based on detected languages."""
    if not languages:
        # No detection, recommend minimal Node (required for Claude Code)
        return LanguageStack.NODE

    lang_set = set(languages)

    # Check for multiple languages - recommend universal
    if len(lang_set) > 2:
        return LanguageStack.UNIVERSAL

    # Single language or two languages - specific stack
    if lang_set == {"node"}:
        return LanguageStack.NODE
    elif lang_set == {"python"} or lang_set == {"node", "python"}:
        return LanguageStack.NODE_PYTHON
    elif "go" in lang_set:
        return LanguageStack.NODE_GO
    elif "rust" in lang_set:
        return LanguageStack.NODE_RUST
    elif "java" in lang_set:
        return LanguageStack.NODE_JAVA
    elif "dotnet" in lang_set:
        return LanguageStack.NODE_DOTNET
    elif "python" in lang_set:
        return LanguageStack.NODE_PYTHON
    else:
        return LanguageStack.UNIVERSAL


def _calculate_confidence(languages: list[str], directory: Path) -> float:
    """Calculate confidence score for detection."""
    if not languages:
        return 0.0

    # More files found = higher confidence
    total_matches = 0
    for lang in languages:
        patterns = LANGUAGE_PATTERNS.get(lang, [])
        for pattern in patterns:
            if _check_glob_pattern(directory, pattern):
                total_matches += 1

    # Confidence based on number of matching files
    # 1 file = 0.5, 2 files = 0.7, 3+ files = 0.9
    if total_matches >= 3:
        return 0.9
    elif total_matches == 2:
        return 0.7
    else:
        return 0.5


def get_stack_for_language(language: str) -> Optional[LanguageStack]:
    """Get the appropriate stack for a specific language."""
    mapping = {
        "node": LanguageStack.NODE,
        "python": LanguageStack.NODE_PYTHON,
        "go": LanguageStack.NODE_GO,
        "rust": LanguageStack.NODE_RUST,
        "java": LanguageStack.NODE_JAVA,
        "dotnet": LanguageStack.NODE_DOTNET,
    }
    return mapping.get(language)
