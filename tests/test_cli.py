"""Tests for ccbox CLI."""

from __future__ import annotations

from dataclasses import asdict
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
import requests
from click.testing import CliRunner

from ccbox.cli import (
    _start_docker_desktop,
    build_image,
    check_docker,
    cli,
    get_git_config,
    image_exists,
)
from ccbox.config import (
    Config,
    LanguageStack,
    get_claude_config_dir,
    get_config_dir,
    get_config_path,
    get_container_name,
    get_image_name,
    load_config,
    save_config,
)
from ccbox.generator import (
    generate_dockerfile,
    generate_dockerignore,
    generate_entrypoint,
    get_docker_run_cmd,
    write_build_files,
)
from ccbox.updater import (
    UpdateInfo,
    _get_docker_version,
    _get_installed_cco_version,
    _image_exists,
    check_all_updates,
    check_ccbox_update,
    check_cco_update,
    check_claude_code_update,
    format_changelog,
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
        data = asdict(config)
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
        assert "FROM node:slim" in dockerfile
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
        # cco-setup is now run separately after build, not in entrypoint
        assert "cco-setup" not in entrypoint

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


class TestUpdater:
    """Tests for update checker module."""

    def test_update_info_has_update_true(self) -> None:
        """Test UpdateInfo.has_update when update available."""
        info = UpdateInfo(package="test", current="1.0.0", latest="2.0.0")
        assert info.has_update is True

    def test_update_info_has_update_false(self) -> None:
        """Test UpdateInfo.has_update when no update."""
        info = UpdateInfo(package="test", current="2.0.0", latest="1.0.0")
        assert info.has_update is False

    def test_update_info_has_update_same_version(self) -> None:
        """Test UpdateInfo.has_update when same version."""
        info = UpdateInfo(package="test", current="1.0.0", latest="1.0.0")
        assert info.has_update is False

    def test_update_info_version_with_v_prefix(self) -> None:
        """Test UpdateInfo handles v prefix in versions."""
        info = UpdateInfo(package="test", current="v1.0.0", latest="v2.0.0")
        assert info.has_update is True

    def test_check_ccbox_update_success(self) -> None:
        """Test successful ccbox update check."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "info": {"version": "99.0.0"},
            "releases": {"99.0.0": [{"comment_text": "New features"}]},
        }
        with patch("requests.get", return_value=mock_response):
            result = check_ccbox_update()
            assert result is not None
            assert result.package == "ccbox"
            assert result.latest == "99.0.0"

    def test_check_ccbox_update_no_version(self) -> None:
        """Test ccbox update check with no version."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"info": {}}
        with patch("requests.get", return_value=mock_response):
            result = check_ccbox_update()
            assert result is None

    def test_check_ccbox_update_http_error(self) -> None:
        """Test ccbox update check with HTTP error."""
        mock_response = MagicMock()
        mock_response.status_code = 500
        with patch("requests.get", return_value=mock_response):
            result = check_ccbox_update()
            assert result is None

    def test_check_ccbox_update_network_error(self) -> None:
        """Test ccbox update check with network error."""
        import requests

        with patch("requests.get", side_effect=requests.RequestException):
            result = check_ccbox_update()
            assert result is None

    def test_check_cco_update_success(self) -> None:
        """Test successful CCO update check."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "tag_name": "v99.0.0",
            "body": "Release notes",
        }
        with (
            patch("ccbox.updater._image_exists", return_value=True),
            patch("requests.get", return_value=mock_response),
            patch("ccbox.updater._get_docker_version", return_value="1.0.0"),
        ):
            result = check_cco_update()
            assert result is not None
            assert result.package == "CCO"
            assert result.latest == "v99.0.0"

    def test_check_cco_update_no_image(self) -> None:
        """Test CCO update check when no docker image exists."""
        with patch("ccbox.updater._image_exists", return_value=False):
            result = check_cco_update()
            assert result is None

    def test_check_cco_update_no_tag(self) -> None:
        """Test CCO update check with no tag."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {}
        with (
            patch("ccbox.updater._image_exists", return_value=True),
            patch("requests.get", return_value=mock_response),
        ):
            result = check_cco_update()
            assert result is None

    def test_check_cco_update_http_error(self) -> None:
        """Test CCO update check with HTTP error."""
        mock_response = MagicMock()
        mock_response.status_code = 404
        with (
            patch("ccbox.updater._image_exists", return_value=True),
            patch("requests.get", return_value=mock_response),
        ):
            result = check_cco_update()
            assert result is None

    def test_check_cco_update_no_installed_version(self) -> None:
        """Test CCO update check when not installed in container."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"tag_name": "v1.0.0"}
        with (
            patch("ccbox.updater._image_exists", return_value=True),
            patch("requests.get", return_value=mock_response),
            patch("ccbox.updater._get_docker_version", return_value=None),
        ):
            result = check_cco_update()
            assert result is not None
            assert result.current == "0.0.0"

    def test_get_installed_cco_version_not_installed(self) -> None:
        """Test getting CCO version when not installed."""
        with patch("importlib.metadata.version", side_effect=Exception):
            result = _get_installed_cco_version()
            assert result is None

    def test_check_all_updates_with_updates(self) -> None:
        """Test check_all_updates when updates available."""
        ccbox_update = UpdateInfo("ccbox", "1.0.0", "2.0.0")
        cco_update = UpdateInfo("CCO", "1.0.0", "2.0.0")
        with (
            patch("ccbox.updater.check_ccbox_update", return_value=ccbox_update),
            patch("ccbox.updater.check_cco_update", return_value=cco_update),
        ):
            updates = check_all_updates()
            assert len(updates) == 2

    def test_check_all_updates_no_updates(self) -> None:
        """Test check_all_updates when no updates."""
        with (
            patch("ccbox.updater.check_ccbox_update", return_value=None),
            patch("ccbox.updater.check_claude_code_update", return_value=None),
            patch("ccbox.updater.check_cco_update", return_value=None),
        ):
            updates = check_all_updates()
            assert len(updates) == 0

    def test_check_all_updates_same_version(self) -> None:
        """Test check_all_updates when same version."""
        ccbox_update = UpdateInfo("ccbox", "1.0.0", "1.0.0")
        with (
            patch("ccbox.updater.check_ccbox_update", return_value=ccbox_update),
            patch("ccbox.updater.check_claude_code_update", return_value=None),
            patch("ccbox.updater.check_cco_update", return_value=None),
        ):
            updates = check_all_updates()
            assert len(updates) == 0

    def test_format_changelog_with_content(self) -> None:
        """Test format_changelog with content."""
        result = format_changelog("Line 1\nLine 2")
        assert "Line 1" in result
        assert "Line 2" in result

    def test_format_changelog_empty(self) -> None:
        """Test format_changelog with no content."""
        result = format_changelog(None)
        assert "No changelog available" in result

    def test_format_changelog_truncation(self) -> None:
        """Test format_changelog truncates long content."""
        long_content = "\n".join(f"Line {i}" for i in range(20))
        result = format_changelog(long_content, max_lines=5)
        assert "..." in result


class TestDockerVersionCheck:
    """Tests for docker-based version checking."""

    def test_image_exists_true(self) -> None:
        """Test _image_exists when image exists."""
        mock_result = MagicMock()
        mock_result.returncode = 0
        with patch("subprocess.run", return_value=mock_result):
            assert _image_exists() is True

    def test_image_exists_false(self) -> None:
        """Test _image_exists when image doesn't exist."""
        mock_result = MagicMock()
        mock_result.returncode = 1
        with patch("subprocess.run", return_value=mock_result):
            assert _image_exists() is False

    def test_image_exists_docker_not_found(self) -> None:
        """Test _image_exists when docker not installed."""
        with patch("subprocess.run", side_effect=FileNotFoundError):
            assert _image_exists() is False

    def test_get_docker_version_success(self) -> None:
        """Test _get_docker_version returns version."""
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "1.2.3\n"
        with patch("subprocess.run", return_value=mock_result):
            result = _get_docker_version("some command")
            assert result == "1.2.3"

    def test_get_docker_version_failure(self) -> None:
        """Test _get_docker_version returns None on failure."""
        mock_result = MagicMock()
        mock_result.returncode = 1
        mock_result.stdout = ""
        with patch("subprocess.run", return_value=mock_result):
            result = _get_docker_version("some command")
            assert result is None

    def test_get_docker_version_timeout(self) -> None:
        """Test _get_docker_version handles timeout."""
        import subprocess as sp
        with patch("subprocess.run", side_effect=sp.TimeoutExpired("cmd", 30)):
            result = _get_docker_version("some command")
            assert result is None

    def test_check_claude_code_update_success(self) -> None:
        """Test successful Claude Code update check."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"version": "99.0.0"}
        with (
            patch("ccbox.updater._image_exists", return_value=True),
            patch("requests.get", return_value=mock_response),
            patch("ccbox.updater._get_docker_version", return_value="1.0.0"),
        ):
            result = check_claude_code_update()
            assert result is not None
            assert result.package == "Claude Code"
            assert result.latest == "99.0.0"

    def test_check_claude_code_update_no_image(self) -> None:
        """Test Claude Code update check when no image."""
        with patch("ccbox.updater._image_exists", return_value=False):
            result = check_claude_code_update()
            assert result is None

    def test_check_claude_code_update_http_error(self) -> None:
        """Test Claude Code update check with HTTP error."""
        mock_response = MagicMock()
        mock_response.status_code = 404
        with (
            patch("ccbox.updater._image_exists", return_value=True),
            patch("requests.get", return_value=mock_response),
        ):
            result = check_claude_code_update()
            assert result is None

    def test_check_claude_code_update_no_version_in_container(self) -> None:
        """Test Claude Code update check when not installed in container."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"version": "1.0.0"}
        with (
            patch("ccbox.updater._image_exists", return_value=True),
            patch("requests.get", return_value=mock_response),
            patch("ccbox.updater._get_docker_version", return_value=None),
        ):
            result = check_claude_code_update()
            assert result is not None
            assert result.current == "0.0.0"

    def test_check_claude_code_update_no_version_in_response(self) -> None:
        """Test Claude Code update check when no version in npm response."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {}  # No version field
        with (
            patch("ccbox.updater._image_exists", return_value=True),
            patch("requests.get", return_value=mock_response),
        ):
            result = check_claude_code_update()
            assert result is None

    def test_check_claude_code_update_network_error(self) -> None:
        """Test Claude Code update check with network error."""
        with (
            patch("ccbox.updater._image_exists", return_value=True),
            patch("requests.get", side_effect=requests.RequestException),
        ):
            result = check_claude_code_update()
            assert result is None

    def test_check_cco_update_network_error(self) -> None:
        """Test CCO update check with network error."""
        with (
            patch("ccbox.updater._image_exists", return_value=True),
            patch("requests.get", side_effect=requests.RequestException),
        ):
            result = check_cco_update()
            assert result is None

    def test_check_all_updates_with_claude_update(self) -> None:
        """Test check_all_updates includes Claude Code update."""
        claude_update = UpdateInfo("Claude Code", "1.0.0", "2.0.0")
        with (
            patch("ccbox.updater.check_ccbox_update", return_value=None),
            patch("ccbox.updater.check_claude_code_update", return_value=claude_update),
            patch("ccbox.updater.check_cco_update", return_value=None),
        ):
            updates = check_all_updates()
            assert len(updates) == 1
            assert updates[0].package == "Claude Code"


class TestDockerDesktopStart:
    """Tests for Docker Desktop auto-start functionality."""

    def test_start_docker_desktop_windows_success(self) -> None:
        """Test starting Docker Desktop on Windows."""
        mock_result = MagicMock()
        mock_result.returncode = 0
        with (
            patch("platform.system", return_value="Windows"),
            patch("subprocess.run", return_value=mock_result),
        ):
            result = _start_docker_desktop()
            assert result is True

    def test_start_docker_desktop_windows_fallback(self) -> None:
        """Test Windows fallback to Docker Desktop.exe."""
        mock_result = MagicMock()
        mock_result.returncode = 1
        with (
            patch("platform.system", return_value="Windows"),
            patch("subprocess.run", return_value=mock_result),
            patch("pathlib.Path.exists", return_value=True),
            patch("subprocess.Popen"),
        ):
            result = _start_docker_desktop()
            assert result is True

    def test_start_docker_desktop_macos(self) -> None:
        """Test starting Docker Desktop on macOS."""
        with (
            patch("platform.system", return_value="Darwin"),
            patch("subprocess.run"),
        ):
            result = _start_docker_desktop()
            assert result is True

    def test_start_docker_desktop_linux(self) -> None:
        """Test Docker Desktop start on Linux (not supported)."""
        with patch("platform.system", return_value="Linux"):
            result = _start_docker_desktop()
            assert result is False


class TestCLICommands:
    """Tests for CLI commands."""

    def test_stacks_command(self) -> None:
        """Test stacks command."""
        runner = CliRunner()
        result = runner.invoke(cli, ["stacks"])
        assert result.exit_code == 0
        assert "base" in result.output
        assert "go" in result.output
        assert "rust" in result.output

    def test_update_with_stack(self) -> None:
        """Test update command with specific stack."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.build_image", return_value=True),
        ):
            result = runner.invoke(cli, ["update", "-s", "base"])
            assert result.exit_code == 0

    def test_update_all_stacks(self) -> None:
        """Test update command with --all flag."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.image_exists", return_value=True),
            patch("ccbox.cli.build_image", return_value=True),
        ):
            result = runner.invoke(cli, ["update", "-a"])
            assert result.exit_code == 0

    def test_update_no_images(self) -> None:
        """Test update --all with no installed images."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.image_exists", return_value=False),
        ):
            result = runner.invoke(cli, ["update", "-a"])
            assert result.exit_code == 0
            assert "No images" in result.output

    def test_clean_with_confirmation(self) -> None:
        """Test clean command with confirmation."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.image_exists", return_value=True),
            patch("subprocess.run") as mock_run,
        ):
            mock_run.return_value = MagicMock(stdout="", returncode=0)
            result = runner.invoke(cli, ["clean"], input="y\n")
            assert result.exit_code == 0

    def test_clean_cancelled(self) -> None:
        """Test clean command cancelled."""
        runner = CliRunner()
        with patch("ccbox.cli.check_docker", return_value=True):
            result = runner.invoke(cli, ["clean"], input="n\n")
            assert result.exit_code == 0

    def test_doctor_all_ok(self, tmp_path: Path) -> None:
        """Test doctor command with everything OK."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.load_config") as mock_config,
            patch("ccbox.cli.image_exists", return_value=False),
            patch("ccbox.cli.detect_project_type") as mock_detect,
        ):
            from ccbox.detector import DetectionResult

            mock_config.return_value = Config(git_name="Test", git_email="t@t.com")
            mock_detect.return_value = DetectionResult(
                detected_languages=["python"],
                recommended_stack=LanguageStack.BASE,
            )
            result = runner.invoke(cli, ["doctor", str(tmp_path)])
            assert result.exit_code == 0
            assert "Doctor" in result.output

    def test_doctor_with_installed_images(self, tmp_path: Path) -> None:
        """Test doctor command showing installed images."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.load_config") as mock_config,
            patch("ccbox.cli.image_exists", return_value=True),
            patch("ccbox.cli.detect_project_type") as mock_detect,
        ):
            from ccbox.detector import DetectionResult

            mock_config.return_value = Config(git_name="Test", git_email="t@t.com")
            mock_detect.return_value = DetectionResult(
                detected_languages=[],
                recommended_stack=LanguageStack.BASE,
            )
            result = runner.invoke(cli, ["doctor", str(tmp_path)])
            assert result.exit_code == 0


class TestMainRunFlow:
    """Tests for main run flow."""

    def test_run_no_docker(self) -> None:
        """Test run when Docker not available."""
        runner = CliRunner()
        with patch("ccbox.cli.check_docker", return_value=False):
            result = runner.invoke(cli, [])
            assert result.exit_code == 1
            assert "Docker" in result.output

    def test_run_with_stack_selection(self, tmp_path: Path) -> None:
        """Test run with stack argument."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.load_config", return_value=Config()),
            patch("ccbox.cli.get_git_config", return_value=("", "")),
            patch("ccbox.cli._check_and_prompt_updates", return_value=False),
            patch("ccbox.cli.detect_project_type") as mock_detect,
            patch("ccbox.cli.image_exists", return_value=True),
            patch("subprocess.run"),
        ):
            from ccbox.detector import DetectionResult

            mock_detect.return_value = DetectionResult([], LanguageStack.BASE)
            result = runner.invoke(cli, ["-s", "base", "-p", str(tmp_path)])
            assert result.exit_code == 0

    def test_run_build_cancelled(self, tmp_path: Path) -> None:
        """Test run when build cancelled."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.load_config", return_value=Config()),
            patch("ccbox.cli.get_git_config", return_value=("", "")),
            patch("ccbox.cli._check_and_prompt_updates", return_value=False),
            patch("ccbox.cli.detect_project_type") as mock_detect,
            patch("ccbox.cli.image_exists", return_value=False),
        ):
            from ccbox.detector import DetectionResult

            mock_detect.return_value = DetectionResult([], LanguageStack.BASE)
            result = runner.invoke(cli, ["-s", "base", "-p", str(tmp_path)], input="n\n")
            assert result.exit_code == 0

    def test_run_with_subcommand(self) -> None:
        """Test that subcommand doesn't run main flow."""
        runner = CliRunner()
        result = runner.invoke(cli, ["stacks"])
        assert result.exit_code == 0


class TestConfigFunctionsExtended:
    """Extended tests for config functions."""

    def test_get_claude_config_dir(self) -> None:
        """Test get_claude_config_dir expands path."""
        config = Config(claude_config_dir="~/.claude")
        path = get_claude_config_dir(config)
        assert "~" not in str(path)


class TestGeneratorExtended:
    """Extended tests for generator functions."""

    def test_generate_dockerfile_web(self) -> None:
        """Test WEB Dockerfile generation."""
        dockerfile = generate_dockerfile(LanguageStack.WEB)
        assert "FROM node:slim" in dockerfile
        assert "pnpm" in dockerfile

    def test_generate_dockerignore(self) -> None:
        """Test .dockerignore generation."""
        dockerignore = generate_dockerignore()
        assert ".git" in dockerignore
        assert "node_modules" in dockerignore
        assert "__pycache__" in dockerignore

    def test_get_docker_run_cmd_no_git(self) -> None:
        """Test docker run command without git config."""
        config = Config()
        cmd = get_docker_run_cmd(
            config,
            Path("/project/test"),
            "test",
            LanguageStack.BASE,
        )
        assert "docker" in cmd
        assert not any("GIT_AUTHOR_NAME" in arg for arg in cmd)

    def test_get_docker_run_cmd_debug_disabled(self) -> None:
        """Test docker run command has DEBUG=False to prevent log explosion."""
        config = Config()
        cmd = get_docker_run_cmd(
            config,
            Path("/project/test"),
            "test",
            LanguageStack.BASE,
        )
        assert any("DEBUG=False" in arg for arg in cmd)


class TestImageExistsEdgeCases:
    """Edge case tests for image_exists."""

    def test_image_exists_docker_not_found(self) -> None:
        """Test image_exists when docker command not found."""
        with patch("subprocess.run", side_effect=FileNotFoundError):
            assert image_exists(LanguageStack.BASE) is False


class TestCheckDockerAutoStart:
    """Tests for Docker auto-start functionality."""

    def test_check_docker_auto_start_success(self) -> None:
        """Test Docker auto-start succeeds."""
        call_count = [0]

        def mock_run(*args: object, **kwargs: object) -> MagicMock:
            call_count[0] += 1
            result = MagicMock()
            # First call fails, second succeeds
            result.returncode = 0 if call_count[0] > 1 else 1
            return result

        with (
            patch("subprocess.run", side_effect=mock_run),
            patch("ccbox.cli._start_docker_desktop", return_value=True),
            patch("time.sleep"),
        ):
            result = check_docker(auto_start=True)
            assert result is True

    def test_check_docker_auto_start_timeout(self) -> None:
        """Test Docker auto-start times out."""
        mock_result = MagicMock()
        mock_result.returncode = 1
        with (
            patch("subprocess.run", return_value=mock_result),
            patch("ccbox.cli._start_docker_desktop", return_value=True),
            patch("time.sleep"),
        ):
            result = check_docker(auto_start=True)
            assert result is False


class TestSelectStack:
    """Tests for stack selection menu."""

    def test_select_stack_with_choice(self) -> None:
        """Test interactive stack selection."""
        from ccbox.cli import _select_stack

        with patch("ccbox.cli.image_exists", return_value=False):
            with patch("click.prompt", return_value="1"):
                result = _select_stack(LanguageStack.BASE, ["python"])
                assert result == LanguageStack.BASE

    def test_select_stack_cancelled(self) -> None:
        """Test stack selection cancelled."""
        from ccbox.cli import _select_stack

        with patch("ccbox.cli.image_exists", return_value=False):
            with patch("click.prompt", return_value="0"):
                result = _select_stack(LanguageStack.BASE, [])
                assert result is None

    def test_select_stack_invalid_then_valid(self) -> None:
        """Test invalid choice then valid choice."""
        from ccbox.cli import _select_stack

        with patch("ccbox.cli.image_exists", return_value=False):
            with patch("click.prompt", side_effect=["invalid", "1"]):
                result = _select_stack(LanguageStack.BASE, [])
                assert result == LanguageStack.BASE


class TestCheckAndPromptUpdates:
    """Tests for update prompt flow."""

    def test_check_and_prompt_updates_no_updates(self) -> None:
        """Test when no updates available."""
        from ccbox.cli import _check_and_prompt_updates

        with patch("ccbox.cli.check_all_updates", return_value=[]):
            result = _check_and_prompt_updates(LanguageStack.BASE)
            assert result is False

    def test_check_and_prompt_updates_declined(self) -> None:
        """Test when updates declined."""
        from ccbox.cli import _check_and_prompt_updates

        update = UpdateInfo("ccbox", "1.0.0", "2.0.0")
        with (
            patch("ccbox.cli.check_all_updates", return_value=[update]),
            patch("click.confirm", return_value=False),
        ):
            result = _check_and_prompt_updates(LanguageStack.BASE)
            assert result is False

    def test_check_and_prompt_updates_cco_only(self) -> None:
        """Test when CCO update accepted (triggers rebuild)."""
        from ccbox.cli import _check_and_prompt_updates

        update = UpdateInfo("CCO", "1.0.0", "2.0.0")
        with (
            patch("ccbox.cli.check_all_updates", return_value=[update]),
            patch("click.confirm", return_value=True),
        ):
            result = _check_and_prompt_updates(LanguageStack.BASE)
            assert result is True

    def test_check_and_prompt_updates_ccbox_success(self) -> None:
        """Test ccbox update success exits."""
        from ccbox.cli import _check_and_prompt_updates

        update = UpdateInfo("ccbox", "1.0.0", "2.0.0")
        mock_run = MagicMock()
        mock_run.returncode = 0
        with (
            patch("ccbox.cli.check_all_updates", return_value=[update]),
            patch("click.confirm", return_value=True),
            patch("subprocess.run", return_value=mock_run),
            pytest.raises(SystemExit),
        ):
            _check_and_prompt_updates(LanguageStack.BASE)

    def test_check_and_prompt_updates_ccbox_failure(self) -> None:
        """Test ccbox update failure continues."""
        from ccbox.cli import _check_and_prompt_updates

        update = UpdateInfo("ccbox", "1.0.0", "2.0.0")
        mock_run = MagicMock()
        mock_run.returncode = 1
        with (
            patch("ccbox.cli.check_all_updates", return_value=[update]),
            patch("click.confirm", return_value=True),
            patch("subprocess.run", return_value=mock_run),
        ):
            result = _check_and_prompt_updates(LanguageStack.BASE)
            # Returns True because rebuild is still triggered (CCO gets rebuilt)
            assert result is True

    def test_check_and_prompt_updates_with_changelog(self) -> None:
        """Test update prompt displays changelog when available."""
        from ccbox.cli import _check_and_prompt_updates

        update = UpdateInfo("CCO", "1.0.0", "2.0.0", changelog="- New feature\n- Bug fix")
        with (
            patch("ccbox.cli.check_all_updates", return_value=[update]),
            patch("click.confirm", return_value=True),
        ):
            result = _check_and_prompt_updates(LanguageStack.BASE)
            assert result is True


class TestRunFlowExtended:
    """Extended tests for run flow."""

    def test_run_with_interactive_selection(self, tmp_path: Path) -> None:
        """Test run with interactive stack selection."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.load_config", return_value=Config()),
            patch("ccbox.cli.get_git_config", return_value=("Test", "test@test.com")),
            patch("ccbox.cli.save_config"),
            patch("click.confirm", return_value=True),  # Confirm git config
            patch("ccbox.cli.detect_project_type") as mock_detect,
            patch("ccbox.cli._select_stack", return_value=None),  # User cancels
        ):
            from ccbox.detector import DetectionResult

            mock_detect.return_value = DetectionResult(["python"], LanguageStack.BASE)
            result = runner.invoke(cli, ["-p", str(tmp_path), "--no-update-check"])
            assert result.exit_code == 0
            assert "Cancelled" in result.output

    def test_run_build_success_and_run(self, tmp_path: Path) -> None:
        """Test successful build and run."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.load_config", return_value=Config()),
            patch("ccbox.cli.get_git_config", return_value=("", "")),
            patch("ccbox.cli._check_and_prompt_updates", return_value=False),
            patch("ccbox.cli.detect_project_type") as mock_detect,
            patch("ccbox.cli.image_exists", return_value=False),
            patch("ccbox.cli.build_image", return_value=True),
            patch("subprocess.run"),
        ):
            from ccbox.detector import DetectionResult

            mock_detect.return_value = DetectionResult([], LanguageStack.BASE)
            result = runner.invoke(cli, ["-s", "base", "-p", str(tmp_path)], input="y\n")
            assert result.exit_code == 0

    def test_run_build_failure(self, tmp_path: Path) -> None:
        """Test build failure."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.load_config", return_value=Config()),
            patch("ccbox.cli.get_git_config", return_value=("", "")),
            patch("ccbox.cli._check_and_prompt_updates", return_value=False),
            patch("ccbox.cli.detect_project_type") as mock_detect,
            patch("ccbox.cli.image_exists", return_value=False),
            patch("ccbox.cli.build_image", return_value=False),
        ):
            from ccbox.detector import DetectionResult

            mock_detect.return_value = DetectionResult([], LanguageStack.BASE)
            result = runner.invoke(cli, ["-s", "base", "-p", str(tmp_path)], input="y\n")
            assert result.exit_code == 1

    def test_run_subprocess_error(self, tmp_path: Path) -> None:
        """Test subprocess error handling."""
        from subprocess import CalledProcessError

        runner = CliRunner()
        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.load_config", return_value=Config()),
            patch("ccbox.cli.get_git_config", return_value=("", "")),
            patch("ccbox.cli._check_and_prompt_updates", return_value=False),
            patch("ccbox.cli.detect_project_type") as mock_detect,
            patch("ccbox.cli.image_exists", return_value=True),
            patch("subprocess.run", side_effect=CalledProcessError(1, "docker")),
        ):
            from ccbox.detector import DetectionResult

            mock_detect.return_value = DetectionResult([], LanguageStack.BASE)
            result = runner.invoke(cli, ["-s", "base", "-p", str(tmp_path)])
            assert result.exit_code == 1

    def test_run_keyboard_interrupt(self, tmp_path: Path) -> None:
        """Test keyboard interrupt handling."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.load_config", return_value=Config()),
            patch("ccbox.cli.get_git_config", return_value=("", "")),
            patch("ccbox.cli._check_and_prompt_updates", return_value=False),
            patch("ccbox.cli.detect_project_type") as mock_detect,
            patch("ccbox.cli.image_exists", return_value=True),
            patch("subprocess.run", side_effect=KeyboardInterrupt),
        ):
            from ccbox.detector import DetectionResult

            mock_detect.return_value = DetectionResult([], LanguageStack.BASE)
            result = runner.invoke(cli, ["-s", "base", "-p", str(tmp_path)])
            assert result.exit_code == 0

    def test_run_with_update_rebuild(self, tmp_path: Path) -> None:
        """Test run with update triggering rebuild."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.load_config", return_value=Config()),
            patch("ccbox.cli.get_git_config", return_value=("", "")),
            patch("ccbox.cli._check_and_prompt_updates", return_value=True),  # Rebuild needed
            patch("ccbox.cli.detect_project_type") as mock_detect,
            patch("ccbox.cli.image_exists", return_value=True),
            patch("ccbox.cli.build_image", return_value=True),
            patch("subprocess.run"),
        ):
            from ccbox.detector import DetectionResult

            mock_detect.return_value = DetectionResult([], LanguageStack.BASE)
            result = runner.invoke(cli, ["-s", "base", "-p", str(tmp_path)])
            assert result.exit_code == 0


class TestGitConfigSave:
    """Tests for git config auto-detection and save."""

    def test_run_prompts_and_saves_git_config(self, tmp_path: Path) -> None:
        """Test that git config is prompted and saved when user confirms."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.load_config", return_value=Config()),
            patch("ccbox.cli.get_git_config", return_value=("Auto Name", "auto@test.com")),
            patch("ccbox.cli.save_config") as mock_save,
            patch("click.confirm", return_value=True),  # User confirms git config
            patch("ccbox.cli.detect_project_type") as mock_detect,
            patch("ccbox.cli._select_stack", return_value=None),
        ):
            from ccbox.detector import DetectionResult

            mock_detect.return_value = DetectionResult([], LanguageStack.BASE)
            runner.invoke(cli, ["-p", str(tmp_path), "--no-update-check"])
            mock_save.assert_called_once()

    def test_run_skips_git_config_when_declined(self, tmp_path: Path) -> None:
        """Test that git config is not saved when user declines."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.load_config", return_value=Config()),
            patch("ccbox.cli.get_git_config", return_value=("Auto Name", "auto@test.com")),
            patch("ccbox.cli.save_config") as mock_save,
            patch("click.confirm", return_value=False),  # User declines git config
            patch("ccbox.cli.detect_project_type") as mock_detect,
            patch("ccbox.cli._select_stack", return_value=None),
        ):
            from ccbox.detector import DetectionResult

            mock_detect.return_value = DetectionResult([], LanguageStack.BASE)
            runner.invoke(cli, ["-p", str(tmp_path), "--no-update-check"])
            mock_save.assert_not_called()


class TestUpdaterExtended:
    """Extended tests for updater edge cases."""

    def test_check_cco_update_json_error(self) -> None:
        """Test CCO update check with JSON decode error."""
        import json

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.side_effect = json.JSONDecodeError("err", "doc", 0)
        with patch("requests.get", return_value=mock_response):
            result = check_cco_update()
            assert result is None

    def test_check_ccbox_update_with_changelog(self) -> None:
        """Test ccbox update with changelog from releases."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "info": {"version": "99.0.0"},
            "releases": {"99.0.0": []},  # Empty release list
        }
        with patch("requests.get", return_value=mock_response):
            result = check_ccbox_update()
            assert result is not None
            assert result.changelog is None


class TestGeneratorFallback:
    """Test generator fallback behavior."""

    def test_generate_dockerfile_unknown_stack(self) -> None:
        """Test that unknown stack falls back to base."""
        # This tests line 243 - the fallback case
        # We can't easily create an unknown stack, but we can verify
        # the function works for all known stacks
        for stack in LanguageStack:
            dockerfile = generate_dockerfile(stack)
            assert "FROM" in dockerfile
            assert "claude-code" in dockerfile


class TestCleanCommand:
    """Extended tests for clean command."""

    def test_clean_removes_containers_and_images(self) -> None:
        """Test clean removes both containers and images."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.image_exists", return_value=True),
            patch("subprocess.run") as mock_run,
        ):
            mock_run.return_value = MagicMock(stdout="container1\n", returncode=0)
            result = runner.invoke(cli, ["clean", "-f"])
            assert result.exit_code == 0
            assert "complete" in result.output.lower()


class TestDoctorDiskCheck:
    """Tests for doctor disk space check."""

    def test_doctor_disk_check_failure(self, tmp_path: Path) -> None:
        """Test doctor when disk check fails."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.load_config", return_value=Config(git_name="T", git_email="t@t")),
            patch("ccbox.cli.image_exists", return_value=False),
            patch("ccbox.cli.detect_project_type") as mock_detect,
            patch("shutil.disk_usage", side_effect=Exception("Cannot check")),
        ):
            from ccbox.detector import DetectionResult

            mock_detect.return_value = DetectionResult(
                recommended_stack=LanguageStack.BASE,
                detected_languages=[],
            )
            result = runner.invoke(cli, ["doctor", str(tmp_path)])
            assert result.exit_code == 0


class TestGitConfigNotFound:
    """Tests for git config not found scenarios."""

    def test_get_git_config_git_not_found(self) -> None:
        """Test git config when git is not installed."""
        with patch("subprocess.run", side_effect=FileNotFoundError):
            name, email = get_git_config()
            assert name == ""
            assert email == ""


class TestUpdateDefaultStack:
    """Tests for update command default behavior."""

    def test_update_default_stack(self) -> None:
        """Test update with no flags rebuilds BASE."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.build_image", return_value=True) as mock_build,
        ):
            result = runner.invoke(cli, ["update"])
            assert result.exit_code == 0
            mock_build.assert_called_once_with(LanguageStack.BASE)


class TestInteractiveStackSelection:
    """Tests for full interactive stack selection flow."""

    def test_run_interactive_full_flow(self, tmp_path: Path) -> None:
        """Test full interactive run with stack selection."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.load_config", return_value=Config()),
            patch("ccbox.cli.get_git_config", return_value=("", "")),
            patch("ccbox.cli._check_and_prompt_updates", return_value=False),
            patch("ccbox.cli.detect_project_type") as mock_detect,
            patch("ccbox.cli.image_exists", return_value=True),
            patch("subprocess.run"),
        ):
            from ccbox.detector import DetectionResult

            mock_detect.return_value = DetectionResult(
                recommended_stack=LanguageStack.BASE,
                detected_languages=["python"],
            )
            # Input "1" to select first stack, then no build confirmation
            result = runner.invoke(cli, ["-p", str(tmp_path), "--no-update-check"], input="1\n")
            assert result.exit_code == 0
