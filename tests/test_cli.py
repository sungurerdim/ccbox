"""Tests for ccbox CLI."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

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
    get_config_dir,
    get_config_path,
    get_container_name,
    get_image_name,
    load_config,
    save_config,
)
from ccbox.generator import (
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

    def test_get_container_name(self) -> None:
        """Test container name generation."""
        assert get_container_name("my-project") == "ccbox-my-project"
        assert get_container_name("My Project") == "ccbox-my-project"
        assert get_container_name("test_app") == "ccbox-test_app"

    def test_image_name(self) -> None:
        """Test image name generation."""
        assert get_image_name(LanguageStack.BASE) == "ccbox:base"
        assert get_image_name(LanguageStack.GO) == "ccbox:go"
        assert get_image_name(LanguageStack.RUST) == "ccbox:rust"

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


class TestGenerator:
    """Tests for Dockerfile and entrypoint generation."""

    def test_generate_dockerfile_base(self) -> None:
        """Test BASE Dockerfile generation."""
        dockerfile = generate_dockerfile(LanguageStack.BASE)
        assert "FROM node:lts-slim" in dockerfile
        assert "@anthropic-ai/claude-code" in dockerfile
        assert "python3" in dockerfile
        assert "ClaudeCodeOptimizer" in dockerfile
        assert "ruff" in dockerfile
        assert "prettier" in dockerfile
        assert "syntax=docker/dockerfile:1" in dockerfile  # BuildKit

    def test_generate_dockerfile_go(self) -> None:
        """Test GO Dockerfile generation."""
        dockerfile = generate_dockerfile(LanguageStack.GO)
        assert "FROM golang:latest" in dockerfile
        assert "golangci-lint" in dockerfile
        assert "@anthropic-ai/claude-code" in dockerfile

    def test_generate_dockerfile_rust(self) -> None:
        """Test RUST Dockerfile generation."""
        dockerfile = generate_dockerfile(LanguageStack.RUST)
        assert "FROM rust:latest" in dockerfile
        assert "clippy" in dockerfile
        assert "rustfmt" in dockerfile

    def test_generate_dockerfile_java(self) -> None:
        """Test JAVA Dockerfile generation."""
        dockerfile = generate_dockerfile(LanguageStack.JAVA)
        assert "FROM eclipse-temurin:latest" in dockerfile
        assert "maven" in dockerfile.lower()

    def test_generate_dockerfile_full(self) -> None:
        """Test FULL Dockerfile generation."""
        dockerfile = generate_dockerfile(LanguageStack.FULL)
        assert "go.dev" in dockerfile
        assert "rustup" in dockerfile
        assert "adoptium" in dockerfile.lower()

    def test_generate_entrypoint(self) -> None:
        """Test entrypoint script generation."""
        entrypoint = generate_entrypoint()
        assert "#!/bin/bash" in entrypoint
        assert "--dangerously-skip-permissions" in entrypoint
        assert "NODE_OPTIONS" in entrypoint
        assert "cco-setup" in entrypoint

    def test_write_build_files(self, tmp_path: Path) -> None:
        """Test writing build files to directory."""
        with patch("ccbox.generator.get_config_dir", return_value=tmp_path):
            build_dir = write_build_files(LanguageStack.BASE)
            assert (build_dir / "Dockerfile").exists()
            assert (build_dir / "entrypoint.sh").exists()
            # Verify stack-specific directory
            assert build_dir.name == "base"

    def test_get_docker_run_cmd(self) -> None:
        """Test docker run command generation."""
        config = Config(git_name="Test", git_email="test@test.com")
        cmd = get_docker_run_cmd(
            config,
            Path("/project/myproject"),
            "myproject",
            LanguageStack.BASE,
        )
        assert "docker" in cmd
        assert "run" in cmd
        assert "--rm" in cmd
        assert "-it" in cmd
        assert "ccbox:base" in cmd
        assert any("GIT_AUTHOR_NAME=Test" in arg for arg in cmd)
        # Verify mounts use directory name
        assert any("/project/myproject:/home/node/myproject:rw" in arg for arg in cmd)
        assert any(".claude:/home/node/.claude:rw" in arg for arg in cmd)
        # Verify workdir uses directory name
        assert any("/home/node/myproject" in arg for arg in cmd)
        # Verify CLAUDE_CONFIG_DIR env var
        assert any("CLAUDE_CONFIG_DIR=/home/node/.claude" in arg for arg in cmd)
        # Verify tmpfs for no residue
        assert "--tmpfs" in cmd
        assert any("/tmp:" in arg for arg in cmd)


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
        assert "Docker" in result.output

    def test_doctor_no_docker(self) -> None:
        """Test doctor command when Docker is not available."""
        runner = CliRunner()
        with patch("ccbox.cli.check_docker", return_value=False):
            result = runner.invoke(cli, ["doctor"])
            assert "Docker" in result.output

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

    def test_update_no_docker(self) -> None:
        """Test update command when Docker is not available."""
        runner = CliRunner()
        with patch("ccbox.cli.check_docker", return_value=False):
            result = runner.invoke(cli, ["update"])
            assert result.exit_code == 1


class TestCLIFunctions:
    """Tests for CLI utility functions."""

    def test_check_docker_available(self) -> None:
        """Test Docker availability check when available."""
        mock_result = MagicMock()
        mock_result.returncode = 0
        with patch("subprocess.run", return_value=mock_result):
            assert check_docker(auto_start=False) is True

    def test_check_docker_not_available(self) -> None:
        """Test Docker availability check when not available."""
        mock_result = MagicMock()
        mock_result.returncode = 1
        with patch("subprocess.run", return_value=mock_result):
            assert check_docker(auto_start=False) is False

    def test_check_docker_not_found(self) -> None:
        """Test Docker availability when command not found."""
        with patch("subprocess.run", side_effect=FileNotFoundError):
            assert check_docker(auto_start=False) is False

    def test_image_exists_true(self) -> None:
        """Test image exists check when image exists."""
        mock_result = MagicMock()
        mock_result.returncode = 0
        with patch("subprocess.run", return_value=mock_result):
            assert image_exists(LanguageStack.BASE) is True

    def test_image_exists_false(self) -> None:
        """Test image exists check when image doesn't exist."""
        mock_result = MagicMock()
        mock_result.returncode = 1
        with patch("subprocess.run", return_value=mock_result):
            assert image_exists(LanguageStack.BASE) is False

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
        with (
            patch("ccbox.cli.write_build_files", return_value=tmp_path),
            patch("subprocess.run") as mock_run,
        ):
            mock_run.return_value = MagicMock(returncode=0)
            result = build_image(LanguageStack.BASE)
            assert result is True

    def test_build_image_failure(self, tmp_path: Path) -> None:
        """Test failed image build."""
        from subprocess import CalledProcessError

        with (
            patch("ccbox.cli.write_build_files", return_value=tmp_path),
            patch("subprocess.run") as mock_run,
        ):
            mock_run.side_effect = CalledProcessError(1, "docker")
            result = build_image(LanguageStack.BASE)
            assert result is False


class TestDetector:
    """Tests for project type detection."""

    def test_detect_python_project(self, tmp_path: Path) -> None:
        """Test Python project detection."""
        from ccbox.detector import detect_project_type

        (tmp_path / "pyproject.toml").touch()
        result = detect_project_type(tmp_path)
        assert "python" in result.detected_languages
        assert result.recommended_stack == LanguageStack.BASE

    def test_detect_node_project(self, tmp_path: Path) -> None:
        """Test Node.js project detection."""
        from ccbox.detector import detect_project_type

        (tmp_path / "package.json").touch()
        result = detect_project_type(tmp_path)
        assert "node" in result.detected_languages
        assert result.recommended_stack == LanguageStack.BASE

    def test_detect_go_project(self, tmp_path: Path) -> None:
        """Test Go project detection."""
        from ccbox.detector import detect_project_type

        (tmp_path / "go.mod").touch()
        result = detect_project_type(tmp_path)
        assert "go" in result.detected_languages
        assert result.recommended_stack == LanguageStack.GO

    def test_detect_rust_project(self, tmp_path: Path) -> None:
        """Test Rust project detection."""
        from ccbox.detector import detect_project_type

        (tmp_path / "Cargo.toml").touch()
        result = detect_project_type(tmp_path)
        assert "rust" in result.detected_languages
        assert result.recommended_stack == LanguageStack.RUST

    def test_detect_java_project(self, tmp_path: Path) -> None:
        """Test Java project detection."""
        from ccbox.detector import detect_project_type

        (tmp_path / "pom.xml").touch()
        result = detect_project_type(tmp_path)
        assert "java" in result.detected_languages
        assert result.recommended_stack == LanguageStack.JAVA

    def test_detect_fullstack_project(self, tmp_path: Path) -> None:
        """Test fullstack (Node + Python) project detection."""
        from ccbox.detector import detect_project_type

        (tmp_path / "package.json").touch()
        (tmp_path / "requirements.txt").touch()
        result = detect_project_type(tmp_path)
        assert "node" in result.detected_languages
        assert "python" in result.detected_languages
        assert result.recommended_stack == LanguageStack.WEB

    def test_detect_multi_compiled_project(self, tmp_path: Path) -> None:
        """Test multi-compiled language project detection."""
        from ccbox.detector import detect_project_type

        (tmp_path / "go.mod").touch()
        (tmp_path / "Cargo.toml").touch()
        result = detect_project_type(tmp_path)
        assert result.recommended_stack == LanguageStack.FULL

    def test_detect_empty_project(self, tmp_path: Path) -> None:
        """Test empty project detection."""
        from ccbox.detector import detect_project_type

        result = detect_project_type(tmp_path)
        assert result.detected_languages == []
        assert result.recommended_stack == LanguageStack.BASE
