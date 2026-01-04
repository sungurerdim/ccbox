"""Tests for dependency detection module.

Tests all package manager detection and installation command generation.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from ccbox.deps import (
    DepsInfo,
    DepsMode,
    PackageManager,
    detect_dependencies,
    get_install_commands,
)


class TestDepsInfo:
    """Tests for DepsInfo dataclass."""

    def test_create_with_list(self) -> None:
        """Test create() converts list to tuple."""
        info = DepsInfo.create(
            name="pip",
            files=["requirements.txt"],
            install_all="pip install -r requirements.txt",
            install_prod="pip install -r requirements.txt",
        )
        assert info.name == "pip"
        assert info.files == ("requirements.txt",)
        assert isinstance(info.files, tuple)

    def test_create_with_multiple_files(self) -> None:
        """Test create() with multiple files."""
        info = DepsInfo.create(
            name="pip",
            files=["requirements.txt", "requirements-dev.txt"],
            install_all="pip install -r requirements.txt -r requirements-dev.txt",
            install_prod="pip install -r requirements.txt",
        )
        assert info.files == ("requirements.txt", "requirements-dev.txt")

    def test_defaults(self) -> None:
        """Test default values."""
        info = DepsInfo.create(
            name="test",
            files=["test.txt"],
            install_all="install",
            install_prod="install",
        )
        assert info.has_dev is True
        assert info.priority == 0

    def test_custom_priority(self) -> None:
        """Test custom priority value."""
        info = DepsInfo.create(
            name="pip",
            files=["pyproject.toml"],
            install_all="pip install",
            install_prod="pip install",
            priority=10,
        )
        assert info.priority == 10

    def test_frozen(self) -> None:
        """Test that DepsInfo is immutable."""
        info = DepsInfo.create(
            name="pip",
            files=["requirements.txt"],
            install_all="pip install",
            install_prod="pip install",
        )
        with pytest.raises(AttributeError):
            info.name = "other"  # type: ignore[misc]


class TestPackageManager:
    """Tests for PackageManager dataclass."""

    def test_create_basic(self) -> None:
        """Test basic creation."""
        pm = PackageManager.create(
            name="npm",
            detect=["package.json"],
            install_all="npm install",
            install_prod="npm install --production",
        )
        assert pm.name == "npm"
        assert pm.detect_files == ("package.json",)
        assert pm.install_all == "npm install"
        assert pm.install_prod == "npm install --production"

    def test_create_with_detect_fn(self) -> None:
        """Test creation with custom detect function."""
        pm = PackageManager.create(
            name="pip",
            detect=["pyproject.toml"],
            detect_fn="_detect_pip_pyproject",
        )
        assert pm.detect_fn == "_detect_pip_pyproject"
        assert pm.install_all is None

    def test_defaults(self) -> None:
        """Test default values."""
        pm = PackageManager.create(
            name="test",
            detect=["test.txt"],
        )
        assert pm.has_dev is True
        assert pm.priority == 5
        assert pm.detect_fn is None


class TestDepsMode:
    """Tests for DepsMode enum."""

    def test_all_mode(self) -> None:
        """Test ALL mode value."""
        assert DepsMode.ALL.value == "all"

    def test_prod_mode(self) -> None:
        """Test PROD mode value."""
        assert DepsMode.PROD.value == "prod"

    def test_skip_mode(self) -> None:
        """Test SKIP mode value."""
        assert DepsMode.SKIP.value == "skip"

    def test_string_enum(self) -> None:
        """Test that DepsMode values are strings and can be used as strings."""
        # DepsMode inherits from str, so values work as strings
        assert DepsMode.ALL.value == "all"
        assert DepsMode.PROD.value == "prod"
        # Can be used in string comparisons
        assert DepsMode.ALL == "all"
        assert DepsMode.PROD == "prod"


class TestDetectDependencies:
    """Tests for detect_dependencies function."""

    def test_empty_directory(self, tmp_path: Path) -> None:
        """Test detection in empty directory."""
        result = detect_dependencies(tmp_path)
        assert result == []

    def test_detect_npm(self, tmp_path: Path) -> None:
        """Test npm detection via package.json."""
        (tmp_path / "package.json").write_text('{"name": "test"}')
        result = detect_dependencies(tmp_path)
        assert len(result) >= 1
        npm_deps = [d for d in result if d.name == "npm"]
        assert len(npm_deps) == 1
        assert "package.json" in npm_deps[0].files

    def test_detect_npm_with_lockfile(self, tmp_path: Path) -> None:
        """Test npm detection with package-lock.json (higher priority)."""
        (tmp_path / "package.json").write_text('{"name": "test"}')
        (tmp_path / "package-lock.json").write_text("{}")
        result = detect_dependencies(tmp_path)
        npm_deps = [d for d in result if d.name == "npm"]
        assert len(npm_deps) == 1
        assert "package-lock.json" in npm_deps[0].files

    def test_detect_pnpm(self, tmp_path: Path) -> None:
        """Test pnpm detection via pnpm-lock.yaml."""
        (tmp_path / "package.json").write_text('{"name": "test"}')
        (tmp_path / "pnpm-lock.yaml").write_text("")
        result = detect_dependencies(tmp_path)
        pnpm_deps = [d for d in result if d.name == "pnpm"]
        assert len(pnpm_deps) == 1

    def test_detect_yarn(self, tmp_path: Path) -> None:
        """Test yarn detection via yarn.lock."""
        (tmp_path / "package.json").write_text('{"name": "test"}')
        (tmp_path / "yarn.lock").write_text("")
        result = detect_dependencies(tmp_path)
        yarn_deps = [d for d in result if d.name == "yarn"]
        assert len(yarn_deps) == 1

    def test_detect_poetry(self, tmp_path: Path) -> None:
        """Test poetry detection via poetry.lock."""
        (tmp_path / "pyproject.toml").write_text("[tool.poetry]")
        (tmp_path / "poetry.lock").write_text("")
        result = detect_dependencies(tmp_path)
        poetry_deps = [d for d in result if d.name == "poetry"]
        assert len(poetry_deps) == 1

    def test_detect_uv(self, tmp_path: Path) -> None:
        """Test uv detection via uv.lock."""
        (tmp_path / "pyproject.toml").write_text("[project]")
        (tmp_path / "uv.lock").write_text("")
        result = detect_dependencies(tmp_path)
        uv_deps = [d for d in result if d.name == "uv"]
        assert len(uv_deps) == 1
        assert "uv sync" in uv_deps[0].install_all

    def test_detect_pip_requirements(self, tmp_path: Path) -> None:
        """Test pip detection via requirements.txt."""
        (tmp_path / "requirements.txt").write_text("flask==2.0.0")
        result = detect_dependencies(tmp_path)
        pip_deps = [d for d in result if d.name == "pip"]
        assert len(pip_deps) == 1
        assert "requirements.txt" in pip_deps[0].files

    def test_detect_pip_requirements_with_dev(self, tmp_path: Path) -> None:
        """Test pip detection with dev requirements."""
        (tmp_path / "requirements.txt").write_text("flask==2.0.0")
        (tmp_path / "requirements-dev.txt").write_text("pytest==7.0.0")
        result = detect_dependencies(tmp_path)
        pip_deps = [d for d in result if d.name == "pip"]
        assert len(pip_deps) == 1
        assert pip_deps[0].has_dev is True
        assert "-r requirements-dev.txt" in pip_deps[0].install_all

    def test_detect_go(self, tmp_path: Path) -> None:
        """Test Go module detection via go.mod."""
        (tmp_path / "go.mod").write_text("module example.com/test")
        result = detect_dependencies(tmp_path)
        go_deps = [d for d in result if d.name == "go"]
        assert len(go_deps) == 1
        assert "go mod download" in go_deps[0].install_all

    def test_detect_cargo(self, tmp_path: Path) -> None:
        """Test Cargo detection via Cargo.toml."""
        (tmp_path / "Cargo.toml").write_text('[package]\nname = "test"')
        result = detect_dependencies(tmp_path)
        cargo_deps = [d for d in result if d.name == "cargo"]
        assert len(cargo_deps) == 1
        assert "cargo fetch" in cargo_deps[0].install_all

    def test_detect_maven(self, tmp_path: Path) -> None:
        """Test Maven detection via pom.xml."""
        (tmp_path / "pom.xml").write_text("<project></project>")
        result = detect_dependencies(tmp_path)
        maven_deps = [d for d in result if d.name == "maven"]
        assert len(maven_deps) == 1
        assert "mvn" in maven_deps[0].install_all

    def test_detect_gradle(self, tmp_path: Path) -> None:
        """Test Gradle detection via build.gradle."""
        (tmp_path / "build.gradle").write_text("apply plugin: 'java'")
        result = detect_dependencies(tmp_path)
        gradle_deps = [d for d in result if d.name == "gradle"]
        assert len(gradle_deps) == 1

    def test_detect_multiple(self, tmp_path: Path) -> None:
        """Test detection of multiple package managers."""
        (tmp_path / "package.json").write_text('{"name": "test"}')
        (tmp_path / "requirements.txt").write_text("flask==2.0.0")
        result = detect_dependencies(tmp_path)
        assert len(result) >= 2
        names = {d.name for d in result}
        assert "npm" in names
        assert "pip" in names

    def test_priority_ordering(self, tmp_path: Path) -> None:
        """Test that results are sorted by priority (highest first)."""
        (tmp_path / "package.json").write_text('{"name": "test"}')
        (tmp_path / "requirements.txt").write_text("flask==2.0.0")
        (tmp_path / "go.mod").write_text("module example.com/test")
        result = detect_dependencies(tmp_path)
        # All should have some priority, and be sorted descending
        priorities = [d.priority for d in result]
        assert priorities == sorted(priorities, reverse=True)

    def test_no_duplicate_managers(self, tmp_path: Path) -> None:
        """Test that same manager isn't detected twice."""
        # Create multiple files that could trigger pip detection
        (tmp_path / "requirements.txt").write_text("flask==2.0.0")
        (tmp_path / "pyproject.toml").write_text("[project]\nname = 'test'")
        result = detect_dependencies(tmp_path)
        pip_count = sum(1 for d in result if d.name == "pip")
        assert pip_count <= 1  # Should detect only once


class TestDetectPipPyproject:
    """Tests for pip detection via pyproject.toml."""

    def test_basic_pyproject(self, tmp_path: Path) -> None:
        """Test detection of basic pyproject.toml."""
        pyproject = tmp_path / "pyproject.toml"
        pyproject.write_text("""
[project]
name = "test"
dependencies = ["flask"]
""")
        result = detect_dependencies(tmp_path)
        pip_deps = [d for d in result if d.name == "pip"]
        assert len(pip_deps) == 1
        assert "pyproject.toml" in pip_deps[0].files

    def test_pyproject_with_optional_dependencies(self, tmp_path: Path) -> None:
        """Test detection with optional-dependencies."""
        pyproject = tmp_path / "pyproject.toml"
        pyproject.write_text("""
[project]
name = "test"
dependencies = ["flask"]

[project.optional-dependencies]
dev = ["pytest"]
""")
        result = detect_dependencies(tmp_path)
        pip_deps = [d for d in result if d.name == "pip"]
        assert len(pip_deps) == 1
        assert pip_deps[0].has_dev is True

    def test_pyproject_skipped_if_poetry_lock(self, tmp_path: Path) -> None:
        """Test that pyproject.toml is skipped if poetry.lock exists."""
        (tmp_path / "pyproject.toml").write_text("[tool.poetry]\nname = 'test'")
        (tmp_path / "poetry.lock").write_text("")
        result = detect_dependencies(tmp_path)
        # Should detect poetry, not pip
        poetry_deps = [d for d in result if d.name == "poetry"]
        pip_deps = [d for d in result if d.name == "pip"]
        assert len(poetry_deps) == 1
        assert len(pip_deps) == 0

    def test_pyproject_skipped_if_uv_lock(self, tmp_path: Path) -> None:
        """Test that pyproject.toml is skipped if uv.lock exists."""
        (tmp_path / "pyproject.toml").write_text("[project]\nname = 'test'")
        (tmp_path / "uv.lock").write_text("")
        result = detect_dependencies(tmp_path)
        # Should detect uv, not pip
        uv_deps = [d for d in result if d.name == "uv"]
        pip_deps = [d for d in result if d.name == "pip"]
        assert len(uv_deps) == 1
        assert len(pip_deps) == 0


class TestGetInstallCommands:
    """Tests for get_install_commands function."""

    def test_all_mode(self) -> None:
        """Test ALL mode returns install_all commands."""
        deps = [
            DepsInfo.create(
                name="npm",
                files=["package.json"],
                install_all="npm install",
                install_prod="npm install --production",
            ),
            DepsInfo.create(
                name="pip",
                files=["requirements.txt"],
                install_all="pip install -r requirements.txt",
                install_prod="pip install -r requirements.txt",
            ),
        ]
        commands = get_install_commands(deps, DepsMode.ALL)
        assert len(commands) == 2
        assert "npm install" in commands
        assert "pip install -r requirements.txt" in commands

    def test_prod_mode(self) -> None:
        """Test PROD mode returns install_prod commands."""
        deps = [
            DepsInfo.create(
                name="npm",
                files=["package.json"],
                install_all="npm install",
                install_prod="npm install --production",
            ),
        ]
        commands = get_install_commands(deps, DepsMode.PROD)
        assert len(commands) == 1
        assert commands[0] == "npm install --production"

    def test_skip_mode(self) -> None:
        """Test SKIP mode returns empty list."""
        deps = [
            DepsInfo.create(
                name="npm",
                files=["package.json"],
                install_all="npm install",
                install_prod="npm install --production",
            ),
        ]
        commands = get_install_commands(deps, DepsMode.SKIP)
        assert commands == []

    def test_empty_deps(self) -> None:
        """Test with empty deps list."""
        commands = get_install_commands([], DepsMode.ALL)
        assert commands == []


class TestEdgeCases:
    """Tests for edge cases and boundary conditions."""

    def test_nonexistent_path(self) -> None:
        """Test with non-existent path."""
        result = detect_dependencies(Path("/nonexistent/path"))
        assert result == []

    def test_file_instead_of_directory(self, tmp_path: Path) -> None:
        """Test with file path instead of directory."""
        file_path = tmp_path / "test.txt"
        file_path.write_text("test")
        result = detect_dependencies(file_path)
        assert result == []

    def test_empty_files(self, tmp_path: Path) -> None:
        """Test detection with empty package files."""
        (tmp_path / "package.json").write_text("")
        # Empty file should still trigger detection (file exists)
        # Note: empty package.json might or might not be detected depending on implementation
        # The important thing is no error is raised
        detect_dependencies(tmp_path)  # Should not raise

    @pytest.mark.skipif(
        sys.platform == "win32", reason="Symlinks require admin on Windows"
    )
    def test_symlink_to_package_file(self, tmp_path: Path) -> None:
        """Test detection with symlinked package file."""
        real_file = tmp_path / "real_package.json"
        real_file.write_text('{"name": "test"}')
        symlink = tmp_path / "package.json"
        symlink.symlink_to(real_file)
        # Should still detect npm
        result = detect_dependencies(tmp_path)
        npm_deps = [d for d in result if d.name == "npm"]
        assert len(npm_deps) >= 1
