"""Dependency detection and installation for ccbox.

Supports any programming language and tech stack with automatic detection.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any


class DepsMode(str, Enum):
    """Dependency installation mode."""

    ALL = "all"  # Install all dependencies including dev
    PROD = "prod"  # Production dependencies only
    SKIP = "skip"  # Don't install dependencies


@dataclass
class DepsInfo:
    """Detected dependency information for a project."""

    name: str  # Package manager name (e.g., "pip", "npm")
    files: list[str]  # Files that triggered detection
    install_all: str  # Command to install all deps (including dev)
    install_prod: str  # Command to install prod-only deps
    cache_paths: dict[str, str]  # host_path -> container_path for caching
    has_dev: bool = True  # Whether dev dependencies are distinguishable
    priority: int = 0  # Higher = run first


# Priority constants for package managers (higher = run first)
PRIORITY_HIGHEST = 10  # Lock files (uv.lock, poetry.lock, pnpm-lock.yaml, etc.)
PRIORITY_HIGH = 5  # Standard package managers (pip, npm, go, cargo, etc.)
PRIORITY_LOW = 3  # Fallback package managers (nuget without lock)
PRIORITY_LOWEST = 1  # Catch-all or legacy detection


# All supported package managers with detection rules
PACKAGE_MANAGERS: list[dict[str, Any]] = [
    # ══════════════════════════════════════════════════════════════════════════
    # Python
    # ══════════════════════════════════════════════════════════════════════════
    {
        "name": "uv",
        "detect": ["uv.lock"],
        "install_all": "uv sync --all-extras",
        "install_prod": "uv sync --no-dev",
        "cache": {"uv": "/root/.cache/uv"},
        "priority": PRIORITY_HIGHEST,
    },
    {
        "name": "poetry",
        "detect": ["poetry.lock"],
        "install_all": "poetry install",
        "install_prod": "poetry install --no-dev",
        "cache": {"poetry": "/root/.cache/pypoetry"},
        "priority": PRIORITY_HIGHEST,
    },
    {
        "name": "pipenv",
        "detect": ["Pipfile.lock", "Pipfile"],
        "install_all": "pipenv install --dev",
        "install_prod": "pipenv install",
        "cache": {"pipenv": "/root/.cache/pipenv"},
        "priority": PRIORITY_HIGHEST,
    },
    {
        "name": "pip",
        "detect": ["pyproject.toml"],
        "detect_fn": "_detect_pip_pyproject",
        "priority": PRIORITY_HIGH,
    },
    {
        "name": "pip",
        "detect": ["requirements.txt"],
        "detect_fn": "_detect_pip_requirements",
        "priority": PRIORITY_HIGH,
    },
    {
        "name": "pip",
        "detect": ["setup.py", "setup.cfg"],
        "install_all": "pip install -e .",
        "install_prod": "pip install -e .",
        "cache": {"pip": "/root/.cache/pip"},
        "has_dev": False,
        "priority": PRIORITY_HIGH,
    },
    {
        "name": "conda",
        "detect": ["environment.yml", "environment.yaml"],
        "install_all": "conda env update -f environment.yml",
        "install_prod": "conda env update -f environment.yml",
        "cache": {"conda": "/root/.conda/pkgs"},
        "has_dev": False,
        "priority": PRIORITY_HIGHEST,
    },
    # ══════════════════════════════════════════════════════════════════════════
    # JavaScript / TypeScript
    # ══════════════════════════════════════════════════════════════════════════
    {
        "name": "bun",
        "detect": ["bun.lockb"],
        "install_all": "bun install",
        "install_prod": "bun install --production",
        "cache": {"bun": "/root/.bun/install/cache"},
        "priority": PRIORITY_HIGHEST,
    },
    {
        "name": "pnpm",
        "detect": ["pnpm-lock.yaml"],
        "install_all": "pnpm install",
        "install_prod": "pnpm install --prod",
        "cache": {"pnpm": "/root/.local/share/pnpm/store"},
        "priority": PRIORITY_HIGHEST,
    },
    {
        "name": "yarn",
        "detect": ["yarn.lock"],
        "install_all": "yarn install",
        "install_prod": "yarn install --production",
        "cache": {"yarn": "/usr/local/share/.cache/yarn"},
        "priority": PRIORITY_HIGHEST,
    },
    {
        "name": "npm",
        "detect": ["package-lock.json", "package.json"],
        "install_all": "npm install",
        "install_prod": "npm install --production",
        "cache": {"npm": "/root/.npm"},
        "priority": PRIORITY_HIGH,
    },
    # ══════════════════════════════════════════════════════════════════════════
    # Go
    # ══════════════════════════════════════════════════════════════════════════
    {
        "name": "go",
        "detect": ["go.mod"],
        "install_all": "go mod download",
        "install_prod": "go mod download",
        "cache": {"go": "/go/pkg/mod"},
        "has_dev": False,
        "priority": PRIORITY_HIGH,
    },
    # ══════════════════════════════════════════════════════════════════════════
    # Rust
    # ══════════════════════════════════════════════════════════════════════════
    {
        "name": "cargo",
        "detect": ["Cargo.toml"],
        "install_all": "cargo fetch",
        "install_prod": "cargo fetch",
        "cache": {"cargo": "/usr/local/cargo/registry"},
        "has_dev": False,
        "priority": PRIORITY_HIGH,
    },
    # ══════════════════════════════════════════════════════════════════════════
    # Java / Kotlin / Scala
    # ══════════════════════════════════════════════════════════════════════════
    {
        "name": "maven",
        "detect": ["pom.xml"],
        "install_all": "mvn dependency:resolve dependency:resolve-plugins -q",
        "install_prod": "mvn dependency:resolve -q",
        "cache": {"maven": "/root/.m2/repository"},
        "has_dev": False,
        "priority": PRIORITY_HIGH,
    },
    {
        "name": "gradle",
        "detect": ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
        "install_all": "gradle dependencies --quiet 2>/dev/null || ./gradlew dependencies --quiet",
        "install_prod": "gradle dependencies --quiet 2>/dev/null || ./gradlew dependencies --quiet",
        "cache": {"gradle": "/root/.gradle/caches"},
        "has_dev": False,
        "priority": PRIORITY_HIGH,
    },
    {
        "name": "sbt",
        "detect": ["build.sbt"],
        "install_all": "sbt update",
        "install_prod": "sbt update",
        "cache": {"sbt": "/root/.sbt", "ivy": "/root/.ivy2/cache"},
        "has_dev": False,
        "priority": PRIORITY_HIGH,
    },
    # ══════════════════════════════════════════════════════════════════════════
    # Ruby
    # ══════════════════════════════════════════════════════════════════════════
    {
        "name": "bundler",
        "detect": ["Gemfile", "Gemfile.lock"],
        "install_all": "bundle install",
        "install_prod": "bundle install --without development test",
        "cache": {"bundler": "/usr/local/bundle/cache"},
        "priority": PRIORITY_HIGH,
    },
    # ══════════════════════════════════════════════════════════════════════════
    # PHP
    # ══════════════════════════════════════════════════════════════════════════
    {
        "name": "composer",
        "detect": ["composer.json", "composer.lock"],
        "install_all": "composer install",
        "install_prod": "composer install --no-dev",
        "cache": {"composer": "/root/.composer/cache"},
        "priority": PRIORITY_HIGH,
    },
    # ══════════════════════════════════════════════════════════════════════════
    # .NET / C#
    # ══════════════════════════════════════════════════════════════════════════
    {
        "name": "dotnet",
        "detect": ["*.csproj", "*.fsproj", "*.sln", "packages.config"],
        "detect_fn": "_detect_dotnet",
        "priority": PRIORITY_HIGH,
    },
    {
        "name": "nuget",
        "detect": ["nuget.config", "packages.config"],
        "install_all": "nuget restore",
        "install_prod": "nuget restore",
        "cache": {"nuget": "/root/.nuget/packages"},
        "has_dev": False,
        "priority": PRIORITY_LOW,
    },
    # ══════════════════════════════════════════════════════════════════════════
    # Elixir / Erlang
    # ══════════════════════════════════════════════════════════════════════════
    {
        "name": "mix",
        "detect": ["mix.exs"],
        "install_all": "mix deps.get",
        "install_prod": "MIX_ENV=prod mix deps.get",
        "cache": {"hex": "/root/.hex", "mix": "/root/.mix"},
        "priority": PRIORITY_HIGH,
    },
    {
        "name": "rebar3",
        "detect": ["rebar.config"],
        "install_all": "rebar3 get-deps",
        "install_prod": "rebar3 get-deps",
        "cache": {"rebar3": "/root/.cache/rebar3"},
        "has_dev": False,
        "priority": PRIORITY_HIGH,
    },
    # ══════════════════════════════════════════════════════════════════════════
    # Haskell
    # ══════════════════════════════════════════════════════════════════════════
    {
        "name": "stack",
        "detect": ["stack.yaml"],
        "install_all": "stack build --only-dependencies",
        "install_prod": "stack build --only-dependencies",
        "cache": {"stack": "/root/.stack"},
        "has_dev": False,
        "priority": PRIORITY_HIGHEST,
    },
    {
        "name": "cabal",
        "detect": ["cabal.project", "*.cabal"],
        "detect_fn": "_detect_cabal",
        "priority": PRIORITY_HIGH,
    },
    # ══════════════════════════════════════════════════════════════════════════
    # Swift
    # ══════════════════════════════════════════════════════════════════════════
    {
        "name": "swift",
        "detect": ["Package.swift"],
        "install_all": "swift package resolve",
        "install_prod": "swift package resolve",
        "cache": {"swift": "/root/.swiftpm"},
        "has_dev": False,
        "priority": PRIORITY_HIGH,
    },
    # ══════════════════════════════════════════════════════════════════════════
    # Dart / Flutter
    # ══════════════════════════════════════════════════════════════════════════
    {
        "name": "pub",
        "detect": ["pubspec.yaml"],
        "install_all": "dart pub get 2>/dev/null || flutter pub get",
        "install_prod": "dart pub get 2>/dev/null || flutter pub get",
        "cache": {"pub": "/root/.pub-cache"},
        "has_dev": False,
        "priority": PRIORITY_HIGH,
    },
    # ══════════════════════════════════════════════════════════════════════════
    # Lua
    # ══════════════════════════════════════════════════════════════════════════
    {
        "name": "luarocks",
        "detect": ["*.rockspec"],
        "detect_fn": "_detect_luarocks",
        "priority": PRIORITY_HIGH,
    },
    # ══════════════════════════════════════════════════════════════════════════
    # R
    # ══════════════════════════════════════════════════════════════════════════
    {
        "name": "renv",
        "detect": ["renv.lock"],
        "install_all": "Rscript -e 'renv::restore()'",
        "install_prod": "Rscript -e 'renv::restore()'",
        "cache": {"renv": "/root/.local/share/renv"},
        "has_dev": False,
        "priority": PRIORITY_HIGH,
    },
    # ══════════════════════════════════════════════════════════════════════════
    # Julia
    # ══════════════════════════════════════════════════════════════════════════
    {
        "name": "julia",
        "detect": ["Project.toml", "Manifest.toml"],
        "install_all": "julia -e 'using Pkg; Pkg.instantiate()'",
        "install_prod": "julia -e 'using Pkg; Pkg.instantiate()'",
        "cache": {"julia": "/root/.julia"},
        "has_dev": False,
        "priority": PRIORITY_HIGH,
    },
    # ══════════════════════════════════════════════════════════════════════════
    # Clojure
    # ══════════════════════════════════════════════════════════════════════════
    {
        "name": "lein",
        "detect": ["project.clj"],
        "install_all": "lein deps",
        "install_prod": "lein deps",
        "cache": {"lein": "/root/.lein", "m2": "/root/.m2/repository"},
        "has_dev": False,
        "priority": PRIORITY_HIGH,
    },
    {
        "name": "clojure",
        "detect": ["deps.edn"],
        "install_all": "clojure -P",
        "install_prod": "clojure -P",
        "cache": {"clojure": "/root/.clojure", "m2": "/root/.m2/repository"},
        "has_dev": False,
        "priority": PRIORITY_HIGH,
    },
    # ══════════════════════════════════════════════════════════════════════════
    # Zig
    # ══════════════════════════════════════════════════════════════════════════
    {
        "name": "zig",
        "detect": ["build.zig.zon"],
        "install_all": "zig fetch",
        "install_prod": "zig fetch",
        "cache": {"zig": "/root/.cache/zig"},
        "has_dev": False,
        "priority": PRIORITY_HIGH,
    },
    # ══════════════════════════════════════════════════════════════════════════
    # Nim
    # ══════════════════════════════════════════════════════════════════════════
    {
        "name": "nimble",
        "detect": ["*.nimble"],
        "detect_fn": "_detect_nimble",
        "priority": PRIORITY_HIGH,
    },
    # ══════════════════════════════════════════════════════════════════════════
    # OCaml
    # ══════════════════════════════════════════════════════════════════════════
    {
        "name": "opam",
        "detect": ["*.opam", "dune-project"],
        "detect_fn": "_detect_opam",
        "priority": PRIORITY_HIGH,
    },
    # ══════════════════════════════════════════════════════════════════════════
    # Perl
    # ══════════════════════════════════════════════════════════════════════════
    {
        "name": "cpanm",
        "detect": ["cpanfile"],
        "install_all": "cpanm --installdeps .",
        "install_prod": "cpanm --installdeps . --without-develop",
        "cache": {"cpan": "/root/.cpan"},
        "priority": PRIORITY_HIGH,
    },
    # ══════════════════════════════════════════════════════════════════════════
    # C / C++
    # ══════════════════════════════════════════════════════════════════════════
    {
        "name": "conan",
        "detect": ["conanfile.txt", "conanfile.py"],
        "install_all": "conan install . --build=missing",
        "install_prod": "conan install . --build=missing",
        "cache": {"conan": "/root/.conan2"},
        "has_dev": False,
        "priority": PRIORITY_HIGH,
    },
    {
        "name": "vcpkg",
        "detect": ["vcpkg.json"],
        "install_all": "vcpkg install",
        "install_prod": "vcpkg install",
        "cache": {"vcpkg": "/root/.cache/vcpkg"},
        "has_dev": False,
        "priority": PRIORITY_HIGH,
    },
    # ══════════════════════════════════════════════════════════════════════════
    # Make-based (generic)
    # ══════════════════════════════════════════════════════════════════════════
    {
        "name": "make",
        "detect": ["Makefile"],
        "detect_fn": "_detect_make",
        "priority": 1,  # Low priority, fallback
    },
]


# ══════════════════════════════════════════════════════════════════════════════
# Custom detection functions for complex cases
# ══════════════════════════════════════════════════════════════════════════════


def _detect_pip_pyproject(path: Path, files: list[str]) -> DepsInfo | None:
    """Detect pip with pyproject.toml, checking for dev extras."""
    pyproject = path / "pyproject.toml"
    if not pyproject.exists():
        return None

    content = pyproject.read_text()

    # Skip if managed by poetry/uv (they have their own lockfiles)
    if (path / "poetry.lock").exists() or (path / "uv.lock").exists():
        return None

    # Check for optional-dependencies (PEP 621) or extras
    has_dev = any(
        x in content
        for x in ["optional-dependencies", "[project.optional-dependencies]", "dev =", "test ="]
    )

    if has_dev:
        return DepsInfo(
            name="pip",
            files=files,
            install_all=(
                'pip install -e ".[dev,test]" 2>/dev/null || '
                'pip install -e ".[dev]" 2>/dev/null || pip install -e .'
            ),
            install_prod="pip install -e .",
            cache_paths={"pip": "/root/.cache/pip"},
            has_dev=True,
            priority=5,
        )

    return DepsInfo(
        name="pip",
        files=files,
        install_all="pip install -e .",
        install_prod="pip install -e .",
        cache_paths={"pip": "/root/.cache/pip"},
        has_dev=False,
        priority=5,
    )


def _detect_pip_requirements(path: Path, files: list[str]) -> DepsInfo | None:
    """Detect pip with requirements.txt, checking for dev requirements."""
    req = path / "requirements.txt"
    if not req.exists():
        return None

    # Check for dev/test requirements files
    dev_files = [
        "requirements-dev.txt",
        "requirements-test.txt",
        "requirements_dev.txt",
        "requirements_test.txt",
        "dev-requirements.txt",
        "test-requirements.txt",
    ]
    found_dev = [f for f in dev_files if (path / f).exists()]

    if found_dev:
        dev_install = " ".join(f"-r {f}" for f in ["requirements.txt", *found_dev])
        return DepsInfo(
            name="pip",
            files=[*files, *found_dev],
            install_all=f"pip install {dev_install}",
            install_prod="pip install -r requirements.txt",
            cache_paths={"pip": "/root/.cache/pip"},
            has_dev=True,
            priority=5,
        )

    return DepsInfo(
        name="pip",
        files=files,
        install_all="pip install -r requirements.txt",
        install_prod="pip install -r requirements.txt",
        cache_paths={"pip": "/root/.cache/pip"},
        has_dev=False,
        priority=5,
    )


def _detect_dotnet(path: Path, files: list[str]) -> DepsInfo | None:
    """Detect .NET projects."""
    # Check for any .csproj, .fsproj, or .sln file
    csproj = list(path.glob("*.csproj"))
    fsproj = list(path.glob("*.fsproj"))
    sln = list(path.glob("*.sln"))

    if csproj or fsproj or sln:
        return DepsInfo(
            name="dotnet",
            files=[str(f.name) for f in [*csproj, *fsproj, *sln]],
            install_all="dotnet restore",
            install_prod="dotnet restore",
            cache_paths={"nuget": "/root/.nuget/packages"},
            has_dev=False,
            priority=5,
        )
    return None


def _detect_cabal(path: Path, files: list[str]) -> DepsInfo | None:
    """Detect Cabal projects."""
    cabal_files = list(path.glob("*.cabal"))
    cabal_project = path / "cabal.project"

    if cabal_files or cabal_project.exists():
        return DepsInfo(
            name="cabal",
            files=[str(f.name) for f in cabal_files]
            + (["cabal.project"] if cabal_project.exists() else []),
            install_all="cabal update && cabal build --only-dependencies",
            install_prod="cabal update && cabal build --only-dependencies",
            cache_paths={"cabal": "/root/.cabal"},
            has_dev=False,
            priority=5,
        )
    return None


def _detect_luarocks(path: Path, files: list[str]) -> DepsInfo | None:
    """Detect LuaRocks projects."""
    rockspecs = list(path.glob("*.rockspec"))
    if rockspecs:
        return DepsInfo(
            name="luarocks",
            files=[str(f.name) for f in rockspecs],
            install_all="luarocks install --only-deps *.rockspec",
            install_prod="luarocks install --only-deps *.rockspec",
            cache_paths={"luarocks": "/root/.luarocks"},
            has_dev=False,
            priority=5,
        )
    return None


def _detect_nimble(path: Path, files: list[str]) -> DepsInfo | None:
    """Detect Nimble projects."""
    nimble_files = list(path.glob("*.nimble"))
    if nimble_files:
        return DepsInfo(
            name="nimble",
            files=[str(f.name) for f in nimble_files],
            install_all="nimble install -d",
            install_prod="nimble install -d",
            cache_paths={"nimble": "/root/.nimble"},
            has_dev=False,
            priority=5,
        )
    return None


def _detect_opam(path: Path, files: list[str]) -> DepsInfo | None:
    """Detect OPAM projects."""
    opam_files = list(path.glob("*.opam"))
    dune_project = path / "dune-project"

    if opam_files or dune_project.exists():
        return DepsInfo(
            name="opam",
            files=[str(f.name) for f in opam_files]
            + (["dune-project"] if dune_project.exists() else []),
            install_all="opam install . --deps-only -y",
            install_prod="opam install . --deps-only -y",
            cache_paths={"opam": "/root/.opam"},
            has_dev=False,
            priority=5,
        )
    return None


def _detect_make(path: Path, files: list[str]) -> DepsInfo | None:
    """Detect Makefile with deps/install target."""
    makefile = path / "Makefile"
    if not makefile.exists():
        return None

    content = makefile.read_text()

    # Check if Makefile has deps/install/dependencies target
    has_deps_target = any(
        f"{target}:" in content for target in ["deps", "install", "dependencies", "setup"]
    )

    if has_deps_target:
        # Try to find the most appropriate target
        for target in ["deps", "dependencies", "install", "setup"]:
            if f"{target}:" in content:
                return DepsInfo(
                    name="make",
                    files=files,
                    install_all=f"make {target}",
                    install_prod=f"make {target}",
                    cache_paths={},
                    has_dev=False,
                    priority=1,
                )
    return None


# ══════════════════════════════════════════════════════════════════════════════
# Main detection logic
# ══════════════════════════════════════════════════════════════════════════════


def _matches_pattern(path: Path, pattern: str) -> list[str]:
    """Check if pattern matches any files in path."""
    if "*" in pattern:
        matches = list(path.glob(pattern))
        return [str(m.name) for m in matches]
    elif (path / pattern).exists():
        return [pattern]
    return []


def detect_dependencies(path: Path) -> list[DepsInfo]:
    """Detect all dependency managers in a project.

    A project may have multiple dependency files (e.g., Python + Node for fullstack).
    Managers are returned sorted by priority (highest first).

    Args:
        path: Project root directory.

    Returns:
        List of detected DepsInfo, sorted by priority.
    """
    results: list[DepsInfo] = []
    detected_managers: set[str] = set()

    for pm in PACKAGE_MANAGERS:
        # Check if any detection files exist
        matched_files: list[str] = []
        for pattern in pm["detect"]:
            matched_files.extend(_matches_pattern(path, pattern))

        if not matched_files:
            continue

        # Use custom detection function if provided
        if "detect_fn" in pm:
            fn_name = pm["detect_fn"]
            fn = globals().get(fn_name)
            if fn:
                result = fn(path, matched_files)
                if result and result.name not in detected_managers:
                    results.append(result)
                    detected_managers.add(result.name)
            continue

        # Skip if we already detected this manager (e.g., pip from pyproject.toml)
        if pm["name"] in detected_managers:
            continue

        # Create DepsInfo from static config
        results.append(
            DepsInfo(
                name=pm["name"],
                files=matched_files,
                install_all=pm["install_all"],
                install_prod=pm["install_prod"],
                cache_paths=pm.get("cache", {}),
                has_dev=pm.get("has_dev", True),
                priority=pm.get("priority", 5),
            )
        )
        detected_managers.add(pm["name"])

    # Sort by priority (highest first)
    results.sort(key=lambda x: x.priority, reverse=True)
    return results


def get_install_commands(deps_list: list[DepsInfo], mode: DepsMode) -> list[str]:
    """Get installation commands for detected dependencies.

    Args:
        deps_list: List of detected dependencies.
        mode: Installation mode (all, prod, skip).

    Returns:
        List of shell commands to run.
    """
    if mode == DepsMode.SKIP:
        return []

    commands = []
    for deps in deps_list:
        if mode == DepsMode.ALL:
            commands.append(deps.install_all)
        else:  # PROD
            commands.append(deps.install_prod)

    return commands


def get_all_cache_paths(deps_list: list[DepsInfo]) -> dict[str, str]:
    """Get all cache paths from detected dependencies.

    Args:
        deps_list: List of detected dependencies.

    Returns:
        Dict of cache_name -> container_path.
    """
    cache_paths: dict[str, str] = {}
    for deps in deps_list:
        cache_paths.update(deps.cache_paths)
    return cache_paths
