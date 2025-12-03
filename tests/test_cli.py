"""Tests for ccbox CLI."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from click.testing import CliRunner

from ccbox.cli import (
    build_image,
    check_docker,
    cli,
    get_git_config,
    image_exists,
)
from ccbox.config import (
    Config,
    LanguageStack,
    STACK_INFO,
    get_config_dir,
    get_config_path,
    get_image_name,
    load_config,
    save_config,
)
from ccbox.detector import detect_project_type, get_stack_for_language
from ccbox.generator import (
    STACK_PACKAGES,
    generate_dockerfile,
    generate_entrypoint,
    get_docker_run_cmd,
    write_build_files,
)


class TestConfig:
    """Tests for configuration model."""

    def test_config_defaults(self) -> None:
        """Test default configuration values."""
        config = Config()
        assert config.git_name == ""
        assert config.git_email == ""
        assert config.claude_config_dir == "~/.claude"

    def test_config_custom_values(self) -> None:
        """Test custom configuration values."""
        config = Config(
            git_name="Test User",
            git_email="test@example.com",
        )
        assert config.git_name == "Test User"
        assert config.git_email == "test@example.com"

    def test_config_serialization(self) -> None:
        """Test config serialization to JSON."""
        config = Config(git_name="Test")
        data = config.model_dump()
        assert data["git_name"] == "Test"


class TestLanguageStack:
    """Tests for language stack enum."""

    def test_stack_values(self) -> None:
        """Test stack enum values."""
        assert LanguageStack.BASE.value == "base"
        assert LanguageStack.PYTHON.value == "python"
        assert LanguageStack.GO.value == "go"
        assert LanguageStack.RUST.value == "rust"
        assert LanguageStack.JAVA.value == "java"
        assert LanguageStack.WEB.value == "web"
        assert LanguageStack.FULL.value == "full"

    def test_stack_info(self) -> None:
        """Test stack info dictionary."""
        for stack in LanguageStack:
            assert stack in STACK_INFO
            desc, size = STACK_INFO[stack]
            assert isinstance(desc, str)
            assert isinstance(size, int)


class TestDetector:
    """Tests for project detection."""

    def test_detect_node_project(self, tmp_path: Path) -> None:
        """Test detection of Node.js project."""
        (tmp_path / "package.json").write_text("{}")
        result = detect_project_type(tmp_path)
        assert "node" in result.detected_languages
        assert result.recommended_stack == LanguageStack.BASE

    def test_detect_python_project(self, tmp_path: Path) -> None:
        """Test detection of Python project."""
        (tmp_path / "pyproject.toml").write_text("")
        result = detect_project_type(tmp_path)
        assert "python" in result.detected_languages
        assert result.recommended_stack == LanguageStack.PYTHON

    def test_detect_go_project(self, tmp_path: Path) -> None:
        """Test detection of Go project."""
        (tmp_path / "go.mod").write_text("")
        result = detect_project_type(tmp_path)
        assert "go" in result.detected_languages
        assert result.recommended_stack == LanguageStack.GO

    def test_detect_rust_project(self, tmp_path: Path) -> None:
        """Test detection of Rust project."""
        (tmp_path / "Cargo.toml").write_text("")
        result = detect_project_type(tmp_path)
        assert "rust" in result.detected_languages
        assert result.recommended_stack == LanguageStack.RUST

    def test_detect_java_project(self, tmp_path: Path) -> None:
        """Test detection of Java project."""
        (tmp_path / "pom.xml").write_text("")
        result = detect_project_type(tmp_path)
        assert "java" in result.detected_languages
        assert result.recommended_stack == LanguageStack.JAVA

    def test_detect_empty_project(self, tmp_path: Path) -> None:
        """Test detection of empty project."""
        result = detect_project_type(tmp_path)
        assert result.detected_languages == []
        assert result.recommended_stack == LanguageStack.BASE

    def test_detect_web_project(self, tmp_path: Path) -> None:
        """Test detection of Node + Python project (web)."""
        (tmp_path / "package.json").write_text("{}")
        (tmp_path / "pyproject.toml").write_text("")
        result = detect_project_type(tmp_path)
        assert "node" in result.detected_languages
        assert "python" in result.detected_languages
        assert result.recommended_stack == LanguageStack.WEB

    def test_get_stack_for_language(self) -> None:
        """Test language to stack mapping."""
        assert get_stack_for_language("python") == LanguageStack.PYTHON
        assert get_stack_for_language("go") == LanguageStack.GO
        assert get_stack_for_language("unknown") is None


class TestGenerator:
    """Tests for Dockerfile and entrypoint generation."""

    def test_generate_dockerfile_base(self) -> None:
        """Test base Dockerfile generation."""
        dockerfile = generate_dockerfile(LanguageStack.BASE)
        assert "FROM node:slim" in dockerfile
        assert "npm install -g @anthropic-ai/claude-code" in dockerfile
        assert "# Base stack" in dockerfile

    def test_generate_dockerfile_python(self) -> None:
        """Test Python Dockerfile generation."""
        dockerfile = generate_dockerfile(LanguageStack.PYTHON)
        assert "python3" in dockerfile
        assert "ruff" in dockerfile
        assert "mypy" in dockerfile

    def test_generate_dockerfile_go(self) -> None:
        """Test Go Dockerfile generation."""
        dockerfile = generate_dockerfile(LanguageStack.GO)
        assert "go.dev" in dockerfile
        assert "GOPATH" in dockerfile

    def test_generate_dockerfile_rust(self) -> None:
        """Test Rust Dockerfile generation."""
        dockerfile = generate_dockerfile(LanguageStack.RUST)
        assert "rustup" in dockerfile
        assert "cargo" in dockerfile

    def test_generate_dockerfile_java(self) -> None:
        """Test Java Dockerfile generation."""
        dockerfile = generate_dockerfile(LanguageStack.JAVA)
        assert "openjdk" in dockerfile
        assert "maven" in dockerfile

    def test_generate_entrypoint(self) -> None:
        """Test entrypoint script generation."""
        entrypoint = generate_entrypoint()
        assert "#!/bin/bash" in entrypoint
        assert "--dangerously-skip-permissions" in entrypoint
        assert "NODE_OPTIONS" in entrypoint

    def test_stack_packages_coverage(self) -> None:
        """Test all stacks have package definitions."""
        for stack in LanguageStack:
            assert stack in STACK_PACKAGES

    def test_write_build_files(self, tmp_path: Path) -> None:
        """Test writing build files to directory."""
        with patch("ccbox.generator.get_config_dir", return_value=tmp_path):
            build_dir = write_build_files(LanguageStack.BASE)
            assert (build_dir / "Dockerfile").exists()
            assert (build_dir / "entrypoint.sh").exists()

    def test_get_docker_run_cmd(self) -> None:
        """Test docker run command generation."""
        config = Config(git_name="Test", git_email="test@test.com")
        cmd = get_docker_run_cmd(
            config,
            Path("/project"),
            "myproject",
            LanguageStack.PYTHON,
        )
        assert "docker" in cmd
        assert "run" in cmd
        assert "--rm" in cmd
        assert "-it" in cmd
        assert "ccbox:python" in cmd
        assert any("GIT_AUTHOR_NAME=Test" in arg for arg in cmd)


class TestConfigFunctions:
    """Tests for config utility functions."""

    def test_get_config_dir(self) -> None:
        """Test config directory path."""
        config_dir = get_config_dir()
        assert config_dir.name == ".ccbox"

    def test_get_config_path(self) -> None:
        """Test config file path."""
        config_path = get_config_path()
        assert config_path.name == "config.json"

    def test_get_image_name(self) -> None:
        """Test image name generation."""
        assert get_image_name(LanguageStack.PYTHON) == "ccbox:python"
        assert get_image_name(LanguageStack.BASE) == "ccbox:base"

    def test_save_and_load_config(self, tmp_path: Path) -> None:
        """Test config persistence."""
        with patch("ccbox.config.get_config_dir", return_value=tmp_path):
            config = Config(git_name="Test User")
            save_config(config)

            loaded = load_config()
            assert loaded.git_name == "Test User"

    def test_load_config_invalid_json(self, tmp_path: Path) -> None:
        """Test loading invalid config file."""
        config_file = tmp_path / "config.json"
        config_file.write_text("invalid json")

        with patch("ccbox.config.get_config_path", return_value=config_file):
            config = load_config()
            assert config.git_name == ""  # Default value


class TestCLI:
    """Tests for CLI commands."""

    def test_version(self) -> None:
        """Test --version flag."""
        runner = CliRunner()
        result = runner.invoke(cli, ["--version"])
        assert result.exit_code == 0
        assert "ccbox" in result.output

    def test_help(self) -> None:
        """Test --help flag."""
        runner = CliRunner()
        result = runner.invoke(cli, ["--help"])
        assert result.exit_code == 0
        assert "ccbox" in result.output

    def test_doctor_no_docker(self) -> None:
        """Test doctor command when Docker is not available."""
        runner = CliRunner()
        with patch("ccbox.cli.check_docker", return_value=False):
            result = runner.invoke(cli, ["doctor"])
            assert "Docker" in result.output

    def test_stacks_command(self) -> None:
        """Test stacks command."""
        runner = CliRunner()
        result = runner.invoke(cli, ["stacks"])
        assert result.exit_code == 0
        assert "base" in result.output
        assert "python" in result.output

    def test_setup_command(self) -> None:
        """Test setup command with input."""
        runner = CliRunner()
        with patch("ccbox.cli.save_config"):
            result = runner.invoke(cli, ["setup"], input="Test User\ntest@test.com\n")
            assert result.exit_code == 0

    def test_clean_no_docker(self) -> None:
        """Test clean command when Docker is not available."""
        runner = CliRunner()
        with patch("ccbox.cli.check_docker", return_value=False):
            result = runner.invoke(cli, ["clean", "-f"])
            assert result.exit_code == 1


class TestCLIFunctions:
    """Tests for CLI utility functions."""

    def test_check_docker_available(self) -> None:
        """Test Docker availability check when available."""
        mock_result = MagicMock()
        mock_result.returncode = 0
        with patch("subprocess.run", return_value=mock_result):
            assert check_docker() is True

    def test_check_docker_not_available(self) -> None:
        """Test Docker availability check when not available."""
        mock_result = MagicMock()
        mock_result.returncode = 1
        with patch("subprocess.run", return_value=mock_result):
            assert check_docker() is False

    def test_check_docker_not_found(self) -> None:
        """Test Docker availability when command not found."""
        with patch("subprocess.run", side_effect=FileNotFoundError):
            assert check_docker() is False

    def test_image_exists_true(self) -> None:
        """Test image exists check when image exists."""
        mock_result = MagicMock()
        mock_result.returncode = 0
        with patch("subprocess.run", return_value=mock_result):
            assert image_exists(LanguageStack.PYTHON) is True

    def test_image_exists_false(self) -> None:
        """Test image exists check when image doesn't exist."""
        mock_result = MagicMock()
        mock_result.returncode = 1
        with patch("subprocess.run", return_value=mock_result):
            assert image_exists(LanguageStack.PYTHON) is False

    def test_get_git_config(self) -> None:
        """Test git config retrieval."""
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "Test User\n"
        with patch("subprocess.run", return_value=mock_result):
            name, email = get_git_config()
            assert name == "Test User"

    def test_build_image_success(self, tmp_path: Path) -> None:
        """Test successful image build."""
        with patch("ccbox.cli.write_build_files", return_value=tmp_path):
            with patch("subprocess.run") as mock_run:
                mock_run.return_value = MagicMock(returncode=0)
                result = build_image(LanguageStack.PYTHON)
                assert result is True

    def test_build_image_failure(self, tmp_path: Path) -> None:
        """Test failed image build."""
        with patch("ccbox.cli.write_build_files", return_value=tmp_path):
            with patch("subprocess.run") as mock_run:
                from subprocess import CalledProcessError

                mock_run.side_effect = CalledProcessError(1, "docker")
                result = build_image(LanguageStack.PYTHON)
                assert result is False
