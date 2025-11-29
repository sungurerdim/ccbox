"""Tests for ccbox CLI."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest
from click.testing import CliRunner

from ccbox.cli import cli
from ccbox.config import Config, LanguageStack, RuntimeMode, get_container_name, get_image_name
from ccbox.detector import detect_project_type


@pytest.fixture
def runner() -> CliRunner:
    """Create a CLI test runner."""
    return CliRunner()


@pytest.fixture
def temp_config_dir(tmp_path: Path) -> Path:
    """Create a temporary config directory."""
    config_dir = tmp_path / ".ccbox"
    config_dir.mkdir()
    return config_dir


class TestConfig:
    """Tests for configuration management."""

    def test_config_defaults(self) -> None:
        """Test default configuration values."""
        config = Config()
        assert config.ram_percent == 75
        assert config.cpu_percent == 100
        assert config.default_mode == RuntimeMode.BYPASS
        assert config.default_stack == LanguageStack.NODE_PYTHON
        assert config.install_cco is False
        assert config.install_gh is False
        assert config.install_gitleaks is False

    def test_config_custom_values(self) -> None:
        """Test custom configuration values."""
        config = Config(
            git_name="Test User",
            git_email="test@example.com",
            ram_percent=50,
            install_cco=True,
        )
        assert config.git_name == "Test User"
        assert config.ram_percent == 50
        assert config.install_cco is True

    def test_config_serialization(self, tmp_path: Path) -> None:
        """Test config save and load."""
        config = Config(
            git_name="Test",
            git_email="test@test.com",
        )
        config_file = tmp_path / "config.json"
        config_file.write_text(json.dumps(config.model_dump()))

        loaded = json.loads(config_file.read_text())
        assert loaded["git_name"] == "Test"


class TestDetector:
    """Tests for project type detection."""

    def test_detect_node_project(self, tmp_path: Path) -> None:
        """Test detection of Node.js project."""
        (tmp_path / "package.json").write_text("{}")
        result = detect_project_type(tmp_path)
        assert "node" in result.detected_languages
        assert result.recommended_stack in [LanguageStack.NODE, LanguageStack.NODE_PYTHON]

    def test_detect_python_project(self, tmp_path: Path) -> None:
        """Test detection of Python project."""
        (tmp_path / "pyproject.toml").write_text("")
        result = detect_project_type(tmp_path)
        assert "python" in result.detected_languages
        assert result.recommended_stack == LanguageStack.NODE_PYTHON

    def test_detect_go_project(self, tmp_path: Path) -> None:
        """Test detection of Go project."""
        (tmp_path / "go.mod").write_text("")
        result = detect_project_type(tmp_path)
        assert "go" in result.detected_languages
        assert result.recommended_stack == LanguageStack.NODE_GO

    def test_detect_rust_project(self, tmp_path: Path) -> None:
        """Test detection of Rust project."""
        (tmp_path / "Cargo.toml").write_text("")
        result = detect_project_type(tmp_path)
        assert "rust" in result.detected_languages
        assert result.recommended_stack == LanguageStack.NODE_RUST

    def test_detect_empty_project(self, tmp_path: Path) -> None:
        """Test detection of empty project."""
        result = detect_project_type(tmp_path)
        assert result.detected_languages == []
        assert result.recommended_stack == LanguageStack.NODE
        assert result.confidence == 0.0

    def test_detect_multi_language(self, tmp_path: Path) -> None:
        """Test detection of multi-language project."""
        (tmp_path / "package.json").write_text("{}")
        (tmp_path / "pyproject.toml").write_text("")
        (tmp_path / "go.mod").write_text("")
        result = detect_project_type(tmp_path)
        assert len(result.detected_languages) == 3
        assert result.recommended_stack == LanguageStack.UNIVERSAL


class TestNaming:
    """Tests for naming conventions."""

    def test_image_name(self) -> None:
        """Test Docker image naming."""
        assert get_image_name(LanguageStack.NODE) == "ccbox:node"
        assert get_image_name(LanguageStack.NODE_PYTHON) == "ccbox:node-python"
        assert get_image_name(LanguageStack.UNIVERSAL) == "ccbox:universal"

    def test_container_name(self) -> None:
        """Test Docker container naming."""
        assert get_container_name("my-project") == "ccbox-my-project"
        assert get_container_name("MyProject") == "ccbox-myproject"
        assert get_container_name("project with spaces") == "ccbox-project-with-spaces"


class TestCLI:
    """Tests for CLI commands."""

    def test_version(self, runner: CliRunner) -> None:
        """Test version command."""
        result = runner.invoke(cli, ["--version"])
        assert result.exit_code == 0
        assert "ccbox" in result.output

    def test_help(self, runner: CliRunner) -> None:
        """Test help command."""
        result = runner.invoke(cli, ["--help"])
        assert result.exit_code == 0
        assert "init" in result.output
        assert "run" in result.output
        assert "doctor" in result.output

    def test_detect_command(self, runner: CliRunner, tmp_path: Path) -> None:
        """Test detect command."""
        (tmp_path / "package.json").write_text("{}")
        result = runner.invoke(cli, ["detect", str(tmp_path)])
        assert result.exit_code == 0
        assert "node" in result.output.lower()

    @patch("ccbox.cli.check_docker")
    def test_doctor_no_docker(self, mock_docker: any, runner: CliRunner) -> None:
        """Test doctor command without Docker."""
        mock_docker.return_value = False
        result = runner.invoke(cli, ["doctor"])
        assert result.exit_code == 0
        assert "FAIL" in result.output or "Docker" in result.output


class TestTemplates:
    """Tests for template generation."""

    def test_dockerfile_template_exists(self) -> None:
        """Test that Dockerfile template exists."""
        from ccbox.generator import get_template
        content = get_template("Dockerfile.template")
        assert "FROM node:slim" in content
        assert "claude" in content.lower()

    def test_compose_template_exists(self) -> None:
        """Test that compose template exists."""
        from ccbox.generator import get_template
        content = get_template("compose.yml.template")
        assert "services:" in content
        assert "volumes:" in content

    def test_entrypoint_template_exists(self) -> None:
        """Test that entrypoint template exists."""
        from ccbox.generator import get_template
        content = get_template("entrypoint.sh.template")
        assert "#!/bin/bash" in content
        assert "NODE_OPTIONS" in content
