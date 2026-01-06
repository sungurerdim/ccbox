"""Tests for ccbox CLI."""

from __future__ import annotations

import re
from dataclasses import asdict
from pathlib import Path
from unittest.mock import MagicMock, patch

from click.testing import CliRunner

# Main CLI imports
from ccbox.cli import cli
from ccbox.cli.build import build_image, get_project_image_name
from ccbox.cli.cleanup import (
    _get_ccbox_image_ids,
    _get_dangling_image_ids,
    _image_has_ccbox_parent,
    cleanup_ccbox_dangling_images,
    prune_stale_resources,
    remove_ccbox_containers,
    remove_ccbox_images,
)
from ccbox.cli.prompts import resolve_stack, select_stack
from ccbox.cli.utils import _start_docker_desktop, check_docker, get_git_config
from ccbox.config import (
    Config,
    LanguageStack,
    get_claude_config_dir,
    get_container_name,
    get_image_name,
    image_exists,
)
from ccbox.detector import detect_project_type
from ccbox.generator import (
    generate_dockerfile,
    generate_entrypoint,
    get_docker_run_cmd,
    write_build_files,
)
from ccbox.paths import resolve_for_docker


def strip_ansi(text: str) -> str:
    """Remove ANSI escape codes from text."""
    return re.sub(r"\x1b\[[0-9;]*m", "", text)


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

    def test_get_container_name(self) -> None:
        """Test container name generation."""
        # Test unique=False (deterministic names)
        assert get_container_name("my-project", unique=False) == "ccbox-my-project"
        assert get_container_name("My Project", unique=False) == "ccbox-my-project"
        assert get_container_name("test_app", unique=False) == "ccbox-test_app"

        # Test unique=True (default) - has random suffix
        name1 = get_container_name("my-project")
        name2 = get_container_name("my-project")
        assert name1.startswith("ccbox-my-project-")
        assert name2.startswith("ccbox-my-project-")
        assert len(name1.split("-")[-1]) == 6  # 6-char hex suffix
        assert name1 != name2  # Each call generates unique name

    def test_image_name(self) -> None:
        """Test image name generation."""
        assert get_image_name(LanguageStack.MINIMAL) == "ccbox:minimal"
        assert get_image_name(LanguageStack.BASE) == "ccbox:base"
        assert get_image_name(LanguageStack.GO) == "ccbox:go"
        assert get_image_name(LanguageStack.RUST) == "ccbox:rust"


class TestGenerator:
    """Tests for Dockerfile and entrypoint generation."""

    def test_generate_dockerfile_minimal(self) -> None:
        """Test MINIMAL Dockerfile generation (no CCO)."""
        dockerfile = generate_dockerfile(LanguageStack.MINIMAL)
        assert "FROM node:lts-slim" in dockerfile
        assert "@anthropic-ai/claude-code" in dockerfile
        assert "python3" in dockerfile
        assert "ClaudeCodeOptimizer" not in dockerfile  # No CCO in minimal
        assert "syntax=docker/dockerfile:1" in dockerfile  # BuildKit

    def test_generate_dockerfile_base(self) -> None:
        """Test BASE Dockerfile generation (minimal + CCO)."""
        dockerfile = generate_dockerfile(LanguageStack.BASE)
        assert "FROM ccbox:minimal" in dockerfile
        assert "ClaudeCodeOptimizer" in dockerfile
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
        """Test FULL Dockerfile generation - layered on base."""
        dockerfile = generate_dockerfile(LanguageStack.FULL)
        assert "FROM ccbox:base" in dockerfile
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

    def test_write_build_files(self) -> None:
        """Test writing build files to directory."""
        # write_build_files uses /tmp/ccbox/build/{stack}
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
        assert "-i" in cmd  # TTY flag (-t) only added when terminal attached
        assert "ccbox:base" in cmd
        assert any("GIT_AUTHOR_NAME=Test" in arg for arg in cmd)
        # Verify mounts use directory name
        project_mount = ":/home/node/myproject:rw"
        assert any(project_mount in arg for arg in cmd)
        # Host .claude mounted rw (full access, no tmpfs overlays in normal mode)
        claude_mount = ":/home/node/.claude:rw"
        assert any(claude_mount in arg for arg in cmd)
        # Normal mode: NO tmpfs overlays for user dirs (host's accessible, CCO merges)
        cmd_str = " ".join(cmd)
        assert "/home/node/.claude/rules:rw,size=16m" not in cmd_str
        assert "/home/node/.claude/commands:rw,size=16m" not in cmd_str
        # Normal mode: NO /dev/null mount for CLAUDE.md (host's used)
        assert "/dev/null:/home/node/.claude/CLAUDE.md" not in cmd_str
        # Verify workdir uses directory name
        assert any("/home/node/myproject" in arg for arg in cmd)
        # Verify CLAUDE_CONFIG_DIR env var
        config_dir = "CLAUDE_CONFIG_DIR=/home/node/.claude"
        assert any(config_dir in arg for arg in cmd)
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
            patch("ccbox.cli.build.write_build_files", return_value=tmp_path),
            patch("subprocess.run") as mock_run,
        ):
            mock_run.return_value = MagicMock(returncode=0)
            result = build_image(LanguageStack.BASE)
            assert result is True

    def test_build_image_failure(self, tmp_path: Path) -> None:
        """Test failed image build."""
        from subprocess import CalledProcessError

        with (
            patch("ccbox.cli.build.image_exists", return_value=True),  # Skip dependency check
            patch("ccbox.cli.build.write_build_files", return_value=tmp_path),
            patch("ccbox.cli.build.subprocess.run") as mock_run,
        ):
            mock_run.side_effect = CalledProcessError(1, "docker")
            result = build_image(LanguageStack.BASE)
            assert result is False

    def test_build_image_with_dependency(self, tmp_path: Path) -> None:
        """Test build_image builds dependencies first for WEB stack."""
        build_calls = []

        def mock_write_build_files(stack: LanguageStack) -> Path:
            build_calls.append(stack)
            return tmp_path

        with (
            patch("ccbox.cli.build.image_exists", return_value=False),
            patch("ccbox.cli.build.write_build_files", side_effect=mock_write_build_files),
            patch("ccbox.cli.build.subprocess.run") as mock_run,
        ):
            mock_run.return_value = MagicMock(returncode=0)
            result = build_image(LanguageStack.WEB)
            assert result is True
            # MINIMAL -> BASE -> WEB
            assert build_calls == [LanguageStack.MINIMAL, LanguageStack.BASE, LanguageStack.WEB]

    def test_build_image_dependency_failure(self, tmp_path: Path) -> None:
        """Test build_image fails if dependency fails."""
        from subprocess import CalledProcessError

        with (
            patch("ccbox.cli.build.image_exists", return_value=False),
            patch("ccbox.cli.build.write_build_files", return_value=tmp_path),
            patch("ccbox.cli.build.subprocess.run") as mock_run,
        ):
            mock_run.side_effect = CalledProcessError(1, "docker")
            result = build_image(LanguageStack.WEB)
            assert result is False

    def test_build_image_skips_dependency_if_exists(self, tmp_path: Path) -> None:
        """Test build_image skips dependency build if base already exists."""
        build_calls = []

        def mock_write_build_files(stack: LanguageStack) -> Path:
            build_calls.append(stack)
            return tmp_path

        with (
            patch("ccbox.cli.image_exists", return_value=True),  # Base exists
            patch("ccbox.cli.build.write_build_files", side_effect=mock_write_build_files),
            patch("subprocess.run") as mock_run,
        ):
            mock_run.return_value = MagicMock(returncode=0)
            result = build_image(LanguageStack.WEB)
            assert result is True
            # Only WEB should be built since BASE exists
            assert build_calls == [LanguageStack.WEB]


class TestDetector:
    """Tests for project type detection."""

    def test_detect_python_project(self, tmp_path: Path) -> None:
        """Test Python project detection."""

        (tmp_path / "pyproject.toml").touch()
        result = detect_project_type(tmp_path)
        assert "python" in result.detected_languages
        assert result.recommended_stack == LanguageStack.BASE

    def test_detect_node_project(self, tmp_path: Path) -> None:
        """Test Node.js project detection."""

        (tmp_path / "package.json").touch()
        result = detect_project_type(tmp_path)
        assert "node" in result.detected_languages
        assert result.recommended_stack == LanguageStack.BASE

    def test_detect_go_project(self, tmp_path: Path) -> None:
        """Test Go project detection."""

        (tmp_path / "go.mod").touch()
        result = detect_project_type(tmp_path)
        assert "go" in result.detected_languages
        assert result.recommended_stack == LanguageStack.GO

    def test_detect_rust_project(self, tmp_path: Path) -> None:
        """Test Rust project detection."""

        (tmp_path / "Cargo.toml").touch()
        result = detect_project_type(tmp_path)
        assert "rust" in result.detected_languages
        assert result.recommended_stack == LanguageStack.RUST

    def test_detect_java_project(self, tmp_path: Path) -> None:
        """Test Java project detection."""

        (tmp_path / "pom.xml").touch()
        result = detect_project_type(tmp_path)
        assert "java" in result.detected_languages
        assert result.recommended_stack == LanguageStack.JAVA

    def test_detect_fullstack_project(self, tmp_path: Path) -> None:
        """Test fullstack (Node + Python) project detection."""

        (tmp_path / "package.json").touch()
        (tmp_path / "requirements.txt").touch()
        result = detect_project_type(tmp_path)
        assert "node" in result.detected_languages
        assert "python" in result.detected_languages
        assert result.recommended_stack == LanguageStack.WEB

    def test_detect_multi_compiled_project(self, tmp_path: Path) -> None:
        """Test multi-compiled language project detection."""

        (tmp_path / "go.mod").touch()
        (tmp_path / "Cargo.toml").touch()
        result = detect_project_type(tmp_path)
        assert result.recommended_stack == LanguageStack.FULL

    def test_detect_empty_project(self, tmp_path: Path) -> None:
        """Test empty project detection."""

        result = detect_project_type(tmp_path)
        assert result.detected_languages == []
        assert result.recommended_stack == LanguageStack.BASE


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
        assert "minimal" in result.output
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
            patch("ccbox.cli.prompts.get_git_config", return_value=("Test", "t@t.com")),
            patch("ccbox.cli.image_exists", return_value=False),
            patch("ccbox.cli.prompts.detect_project_type") as mock_detect,
        ):
            from ccbox.detector import DetectionResult

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
            patch("ccbox.cli.prompts.get_git_config", return_value=("Test", "t@t.com")),
            patch("ccbox.cli.image_exists", return_value=True),
            patch("ccbox.cli.prompts.detect_project_type") as mock_detect,
        ):
            from ccbox.detector import DetectionResult

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
        with patch("ccbox.cli.run.check_docker", return_value=False):
            result = runner.invoke(cli, [])
            assert result.exit_code == 1
            assert "Docker" in result.output

    def test_run_with_stack_selection(self, tmp_path: Path) -> None:
        """Test run with stack argument."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.run.check_docker", return_value=True),
            patch("ccbox.cli.run.prune_stale_resources", return_value={}),
            patch("ccbox.cli.run.setup_git_config") as mock_setup_git,
            patch("ccbox.cli.run.detect_project_type") as mock_detect,
            patch("ccbox.cli.run.detect_dependencies", return_value=[]),
            patch("ccbox.cli.run.image_exists", return_value=True),
            patch("ccbox.cli.run.project_image_exists", return_value=True),
            patch("ccbox.cli.run.get_project_image_name", return_value="ccbox-test:base"),
            patch("ccbox.cli.run.get_docker_run_cmd", return_value=["echo", "test"]),
            patch("ccbox.cli.run.sleepctl.run_with_sleep_inhibition", return_value=0),
        ):
            from ccbox.config import Config
            from ccbox.detector import DetectionResult

            mock_setup_git.return_value = Config()
            mock_detect.return_value = DetectionResult([], LanguageStack.BASE)
            result = runner.invoke(cli, ["-s", "base", "-p", str(tmp_path)])
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
        """Test WEB Dockerfile generation - layered on base."""
        dockerfile = generate_dockerfile(LanguageStack.WEB)
        assert "FROM ccbox:base" in dockerfile
        assert "pnpm" in dockerfile

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

    def test_get_docker_run_cmd_debug_logs_tmpfs_default(self) -> None:
        """Test docker run command uses tmpfs for debug logs by default."""
        config = Config()
        cmd = get_docker_run_cmd(
            config,
            Path("/project/test"),
            "test",
            LanguageStack.BASE,
        )
        # Debug logs use tmpfs by default (ephemeral), mode 0777 for dynamic UID
        cmd_str = " ".join(cmd)
        assert "--tmpfs" in cmd_str
        assert "/home/node/.claude/debug:rw,size=512m,mode=0777" in cmd_str

    def test_get_docker_run_cmd_debug_logs_persistent(self) -> None:
        """Test docker run command skips tmpfs when debug_logs=True."""
        config = Config()
        cmd = get_docker_run_cmd(
            config,
            Path("/project/test"),
            "test",
            LanguageStack.BASE,
            debug_logs=True,
        )
        # Debug logs persistent - no tmpfs for debug dir
        cmd_str = " ".join(cmd)
        assert "/home/node/.claude/debug" not in cmd_str

    def test_get_docker_run_cmd_bare_mode(self) -> None:
        """Test bare mode mounts only credentials, not full ~/.claude directory."""
        claude_dir = Path.home() / ".claude-test-bare"
        claude_dir.mkdir(exist_ok=True)
        creds_file = claude_dir / ".credentials.json"
        creds_file.write_text('{"key": "test"}')
        claude_json_file = claude_dir / ".claude.json"
        claude_json_file.write_text('{"projects": {}}')
        settings_file = claude_dir / "settings.json"
        settings_file.write_text('{"theme": "dark"}')

        try:
            config = Config(claude_config_dir=str(claude_dir))
            cmd = get_docker_run_cmd(
                config,
                Path("/project/test"),
                "test",
                LanguageStack.BASE,
                bare=True,
            )
            cmd_str = " ".join(cmd)

            # VANILLA mode: NO full ~/.claude mount
            docker_claude_dir = resolve_for_docker(claude_dir)
            assert f"{docker_claude_dir}:/home/node/.claude:rw" not in cmd_str

            # VANILLA mode: Only credential files are mounted
            docker_creds = resolve_for_docker(creds_file)
            assert f"{docker_creds}:/home/node/.claude/.credentials.json:rw" in cmd_str
            docker_claude_json = resolve_for_docker(claude_json_file)
            assert f"{docker_claude_json}:/home/node/.claude/.claude.json:rw" in cmd_str
            docker_settings = resolve_for_docker(settings_file)
            assert f"{docker_settings}:/home/node/.claude/settings.json:rw" in cmd_str

            # User customization dirs are empty tmpfs
            assert "--tmpfs /home/node/.claude/rules:rw,size=16m" in cmd_str
            assert "--tmpfs /home/node/.claude/commands:rw,size=16m" in cmd_str
            assert "--tmpfs /home/node/.claude/agents:rw,size=16m" in cmd_str
            assert "--tmpfs /home/node/.claude/skills:rw,size=16m" in cmd_str

            # CLAUDE.md is hidden via /dev/null mount
            assert "/dev/null:/home/node/.claude/CLAUDE.md:ro" in cmd_str

            # Bare mode flag
            assert "CCBOX_BARE_MODE=1" in cmd_str
        finally:
            creds_file.unlink(missing_ok=True)
            claude_json_file.unlink(missing_ok=True)
            settings_file.unlink(missing_ok=True)
            claude_dir.rmdir()

    def test_get_docker_run_cmd_normal_mode_no_bare_flag(self) -> None:
        """Test normal mode does not set CCBOX_BARE_MODE."""
        claude_dir = Path.home() / ".claude-test-normal"
        claude_dir.mkdir(exist_ok=True)
        creds_file = claude_dir / ".credentials.json"
        creds_file.write_text('{"key": "test"}')

        try:
            config = Config(claude_config_dir=str(claude_dir))
            cmd = get_docker_run_cmd(
                config,
                Path("/project/test"),
                "test",
                LanguageStack.BASE,
                bare=False,
            )
            cmd_str = " ".join(cmd)
            # Host .claude mounted rw (use Docker-format path for assertion)
            docker_claude_dir = resolve_for_docker(claude_dir)
            assert f"{docker_claude_dir}:/home/node/.claude:rw" in cmd_str
            # Normal mode: NO tmpfs overlays (host's accessible, CCO merges)
            assert "/home/node/.claude/rules:rw,size=16m" not in cmd_str
            assert "/dev/null:/home/node/.claude/CLAUDE.md" not in cmd_str
            # Normal mode: no CCBOX_BARE_MODE flag
            assert "CCBOX_BARE_MODE" not in cmd_str
        finally:
            creds_file.unlink(missing_ok=True)
            claude_dir.rmdir()


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
            patch("ccbox.cli.utils._start_docker_desktop", return_value=True),
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
            patch("ccbox.cli.utils._start_docker_desktop", return_value=True),
            patch("time.sleep"),
        ):
            result = check_docker(auto_start=True)
            assert result is False


class TestSelectStack:
    """Tests for stack selection menu."""

    def testselect_stack_with_choice(self) -> None:
        """Test interactive stack selection."""

        with (
            patch("ccbox.cli.prompts.get_installed_ccbox_images", return_value=set()),
            patch("click.prompt", return_value="1"),
        ):
            # Choice "1" selects first stack (MINIMAL)
            result = select_stack(LanguageStack.BASE, ["python"])
            assert result == LanguageStack.MINIMAL

    def testselect_stack_cancelled(self) -> None:
        """Test stack selection cancelled."""

        with (
            patch("ccbox.cli.prompts.get_installed_ccbox_images", return_value=set()),
            patch("click.prompt", return_value="0"),
        ):
            result = select_stack(LanguageStack.BASE, [])
            assert result is None

    def testselect_stack_invalid_then_valid(self) -> None:
        """Test invalid choice then valid choice."""

        with (
            patch("ccbox.cli.prompts.get_installed_ccbox_images", return_value=set()),
            patch("click.prompt", side_effect=["invalid", "1"]),
        ):
            # Choice "1" selects first stack (MINIMAL)
            result = select_stack(LanguageStack.BASE, [])
            assert result == LanguageStack.MINIMAL


class TestStackAuto:
    """Tests for --stack=auto option."""

    def test_stack_auto_uses_detected_stack(self, tmp_path: Path) -> None:
        """Test --stack=auto uses detected stack without prompting."""
        from ccbox.detector import DetectionResult

        with patch("ccbox.cli.prompts.detect_project_type") as mock_detect:
            mock_detect.return_value = DetectionResult(
                detected_languages=["go"],
                recommended_stack=LanguageStack.GO,
            )
            result = resolve_stack("auto", tmp_path)
            assert result == LanguageStack.GO

    def test_stack_auto_skips_menu(self, tmp_path: Path) -> None:
        """Test --stack=auto does not call select_stack."""
        from ccbox.detector import DetectionResult

        with (
            patch("ccbox.cli.prompts.detect_project_type") as mock_detect,
            patch("ccbox.cli.prompts.select_stack") as mock_select,
        ):
            mock_detect.return_value = DetectionResult([], LanguageStack.RUST)
            resolve_stack("auto", tmp_path)
            mock_select.assert_not_called()


class TestRunFlowExtended:
    """Extended tests for run flow."""

    def test_run_with_interactive_selection(self, tmp_path: Path) -> None:
        """Test run with interactive stack selection - user cancels."""
        runner = CliRunner()

        with (
            patch("ccbox.cli.run.check_docker", return_value=True),
            patch("ccbox.cli.run.prune_stale_resources", return_value={}),
            patch("ccbox.cli.run.setup_git_config") as mock_setup_git,
            patch("ccbox.cli.run.detect_project_type") as mock_detect,
            patch("ccbox.cli.run.detect_dependencies", return_value=[]),
            patch("ccbox.cli.run.project_image_exists", return_value=False),
            patch("ccbox.cli.run.resolve_stack", return_value=None),  # User cancels
        ):
            from ccbox.config import Config
            from ccbox.detector import DetectionResult

            mock_setup_git.return_value = Config()
            mock_detect.return_value = DetectionResult(
                recommended_stack=LanguageStack.GO,
                detected_languages=["go"],
            )
            result = runner.invoke(cli, ["-p", str(tmp_path)])
            assert result.exit_code == 0
            assert "Cancelled" in result.output

    def test_run_build_success_and_run(self, tmp_path: Path) -> None:
        """Test successful build and run."""
        runner = CliRunner()

        with (
            patch("ccbox.cli.run.check_docker", return_value=True),
            patch("ccbox.cli.run.prune_stale_resources", return_value={}),
            patch("ccbox.cli.run.setup_git_config") as mock_setup_git,
            patch("ccbox.cli.run.detect_project_type") as mock_detect,
            patch("ccbox.cli.run.detect_dependencies", return_value=[]),
            patch("ccbox.cli.run.project_image_exists", return_value=False),
            patch("ccbox.cli.run.image_exists", return_value=True),
            patch("ccbox.cli.run.ensure_image_ready", return_value=True),
            patch("ccbox.cli.run.build_project_image", return_value=None),
            patch("ccbox.cli.run.get_docker_run_cmd", return_value=["echo", "test"]),
            patch("ccbox.cli.run.sleepctl.run_with_sleep_inhibition", return_value=0),
        ):
            from ccbox.config import Config
            from ccbox.detector import DetectionResult

            mock_setup_git.return_value = Config()
            mock_detect.return_value = DetectionResult([], LanguageStack.GO)
            result = runner.invoke(cli, ["-s", "go", "-p", str(tmp_path)])
            assert result.exit_code == 0

    def test_run_build_failure(self, tmp_path: Path) -> None:
        """Test build failure."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.run.check_docker", return_value=True),
            patch("ccbox.cli.run.prune_stale_resources", return_value={}),
            patch("ccbox.cli.run.setup_git_config") as mock_setup_git,
            patch("ccbox.cli.run.detect_project_type") as mock_detect,
            patch("ccbox.cli.run.detect_dependencies", return_value=[]),
            patch("ccbox.cli.run.project_image_exists", return_value=False),
            patch("ccbox.cli.run.image_exists", return_value=False),
            patch("ccbox.cli.run.build_image", return_value=False),
        ):
            from ccbox.config import Config
            from ccbox.detector import DetectionResult

            mock_setup_git.return_value = Config()
            mock_detect.return_value = DetectionResult([], LanguageStack.BASE)
            result = runner.invoke(cli, ["-s", "base", "-p", str(tmp_path)])
            assert result.exit_code == 1

    def test_run_subprocess_error(self, tmp_path: Path) -> None:
        """Test subprocess error handling."""
        from subprocess import CalledProcessError

        runner = CliRunner()
        with (
            patch("ccbox.cli.run.check_docker", return_value=True),
            patch("ccbox.cli.run.prune_stale_resources", return_value={}),
            patch("ccbox.cli.run.setup_git_config") as mock_setup_git,
            patch("ccbox.cli.run.detect_project_type") as mock_detect,
            patch("ccbox.cli.run.detect_dependencies", return_value=[]),
            patch("ccbox.cli.run.project_image_exists", return_value=True),
            patch("ccbox.cli.run.get_project_image_name", return_value="ccbox-test:base"),
            patch("ccbox.cli.run.get_docker_run_cmd", return_value=["docker", "run"]),
            patch(
                "ccbox.cli.run.sleepctl.run_with_sleep_inhibition",
                side_effect=CalledProcessError(1, "docker"),
            ),
        ):
            from ccbox.config import Config
            from ccbox.detector import DetectionResult

            mock_setup_git.return_value = Config()
            mock_detect.return_value = DetectionResult([], LanguageStack.BASE)
            result = runner.invoke(cli, ["-s", "base", "-p", str(tmp_path)])
            assert result.exit_code == 1

    def test_run_keyboard_interrupt(self, tmp_path: Path) -> None:
        """Test keyboard interrupt handling during container execution."""
        runner = CliRunner()

        # Mock run_with_sleep_inhibition to raise KeyboardInterrupt
        def sleep_inhibit_side_effect(*args: object, **kwargs: object) -> int:
            raise KeyboardInterrupt

        with (
            patch("ccbox.cli.run.check_docker", return_value=True),
            patch("ccbox.cli.run.prune_stale_resources", return_value={}),
            patch("ccbox.cli.run.setup_git_config") as mock_setup_git,
            patch("ccbox.cli.run.detect_project_type") as mock_detect,
            patch("ccbox.cli.run.detect_dependencies", return_value=[]),
            patch("ccbox.cli.run.project_image_exists", return_value=True),
            patch("ccbox.cli.run.get_project_image_name", return_value="ccbox-test:base"),
            patch("ccbox.cli.run.get_docker_run_cmd", return_value=["docker", "run"]),
            patch(
                "ccbox.cli.run.sleepctl.run_with_sleep_inhibition",
                side_effect=sleep_inhibit_side_effect,
            ),
        ):
            from ccbox.config import Config
            from ccbox.detector import DetectionResult

            mock_setup_git.return_value = Config()
            mock_detect.return_value = DetectionResult([], LanguageStack.BASE)
            result = runner.invoke(cli, ["-s", "base", "-p", str(tmp_path)])
            assert result.exit_code == 0


class TestGeneratorFallback:
    """Test generator fallback behavior."""

    def test_generate_dockerfile_all_stacks(self) -> None:
        """Test that all stacks generate valid Dockerfiles."""
        for stack in LanguageStack:
            dockerfile = generate_dockerfile(stack)
            assert "FROM" in dockerfile
            # MINIMAL, GO, RUST, JAVA include claude-code directly
            # BASE inherits from ccbox:minimal
            # WEB and FULL inherit from ccbox:base
            if stack == LanguageStack.BASE:
                assert "FROM ccbox:minimal" in dockerfile
                assert "ClaudeCodeOptimizer" in dockerfile
            elif stack in (LanguageStack.WEB, LanguageStack.FULL):
                assert "FROM ccbox:base" in dockerfile
            else:
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


class TestPruneCommand:
    """Tests for prune command (deep clean)."""

    def test_prune_requires_confirmation(self) -> None:
        """Test prune requires confirmation without --force."""
        runner = CliRunner()
        with patch("ccbox.cli.check_docker", return_value=True):
            result = runner.invoke(cli, ["prune"], input="n\n")
            assert result.exit_code == 0
            assert "Cancelled" in result.output

    def test_prune_with_force_flag(self) -> None:
        """Test prune skips confirmation with --force."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("subprocess.run") as mock_run,
            patch("pathlib.Path.exists", return_value=False),
        ):
            mock_run.return_value = MagicMock(stdout="", returncode=0)
            result = runner.invoke(cli, ["prune", "-f"])
            assert result.exit_code == 0
            assert "Deep clean complete" in result.output

    def test_prune_no_docker(self) -> None:
        """Test prune when Docker is not running."""
        runner = CliRunner()
        with patch("ccbox.cli.check_docker", return_value=False):
            result = runner.invoke(cli, ["prune", "-f"])
            assert result.exit_code == 1
            assert "Docker" in result.output

    def test_prune_only_targets_ccbox_resources(self) -> None:
        """Test prune only removes ccbox-prefixed resources."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("subprocess.run") as mock_run,
            patch("pathlib.Path.exists", return_value=False),
        ):
            mock_run.return_value = MagicMock(stdout="ccbox-project-abc123\n", returncode=0)
            result = runner.invoke(cli, ["prune", "-f"])
            assert result.exit_code == 0
            # Verify docker commands target ccbox- prefix
            calls = [str(call) for call in mock_run.call_args_list]
            assert any("ccbox-" in call for call in calls)


class TestPruneSystemFlag:
    """Tests for prune --system flag (full Docker cleanup)."""

    def test_prune_system_requires_confirmation(self) -> None:
        """Test prune --system requires confirmation."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch(
                "ccbox.cli.cleanup.get_docker_disk_usage",
                return_value={
                    "containers": "0B",
                    "images": "1GB",
                    "volumes": "500MB",
                    "cache": "2GB",
                },
            ),
        ):
            result = runner.invoke(cli, ["prune", "--system"], input="n\n")
            assert result.exit_code == 0
            assert "Cancelled" in result.output

    def test_prune_system_shows_warning(self) -> None:
        """Test prune --system shows warning about affecting all Docker projects."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch(
                "ccbox.cli.cleanup.get_docker_disk_usage",
                return_value={
                    "containers": "0B",
                    "images": "1GB",
                    "volumes": "500MB",
                    "cache": "2GB",
                },
            ),
        ):
            result = runner.invoke(cli, ["prune", "--system"], input="n\n")
            assert "WARNING" in result.output
            assert "ALL Docker projects" in result.output

    def test_prune_system_with_force(self) -> None:
        """Test prune --system -f skips confirmation."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.cleanup.subprocess.run") as mock_run,
            patch(
                "ccbox.cli.cleanup.get_docker_disk_usage",
                return_value={"containers": "0B", "images": "0B", "volumes": "0B", "cache": "0B"},
            ),
        ):
            mock_run.return_value = MagicMock(stdout="", returncode=0)
            result = runner.invoke(cli, ["prune", "--system", "-f"])
            assert result.exit_code == 0
            assert "System cleanup complete" in result.output

    def test_prune_system_shows_disk_usage_table(self) -> None:
        """Test prune --system shows disk usage table."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch(
                "ccbox.cli.cleanup.get_docker_disk_usage",
                return_value={
                    "containers": "0B",
                    "images": "1.5GB",
                    "volumes": "500MB",
                    "cache": "3GB",
                },
            ),
        ):
            result = runner.invoke(cli, ["prune", "--system"], input="n\n")
            assert "Containers" in result.output
            assert "Images" in result.output
            assert "Volumes" in result.output
            assert "Build Cache" in result.output

    def test_prune_system_help_shows_option(self) -> None:
        """Test --system option appears in help."""
        runner = CliRunner()
        result = runner.invoke(cli, ["prune", "--help"])
        assert "--system" in result.output
        assert "Docker system" in result.output or "entire Docker" in result.output


class TestPruneStaleResources:
    """Tests for pre-run stale resource cleanup."""

    def testprune_stale_resources_removes_exited_containers(self) -> None:
        """Test prune_stale_resources removes exited ccbox containers."""

        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(stdout="abc123\ndef456\n", returncode=0)
            results = prune_stale_resources(verbose=False)
            assert results["containers"] == 2

    def testprune_stale_resources_no_containers(self) -> None:
        """Test prune_stale_resources when no stale containers exist."""

        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(stdout="", returncode=0)
            results = prune_stale_resources(verbose=False)
            assert results["containers"] == 0

    def testprune_stale_resources_timeout_handling(self) -> None:
        """Test prune_stale_resources handles timeout gracefully."""
        from subprocess import TimeoutExpired

        with patch("subprocess.run", side_effect=TimeoutExpired(cmd="docker", timeout=30)):
            results = prune_stale_resources(verbose=False)
            assert results["containers"] == 0


class TestNoPruneFlag:
    """Tests for --no-prune CLI flag."""

    def test_no_prune_flag_in_help(self) -> None:
        """Test --no-prune flag appears in help."""
        runner = CliRunner()
        result = runner.invoke(cli, ["--help"])
        assert "--no-prune" in result.output
        assert "Skip automatic cleanup" in result.output


class TestDoctorDiskCheck:
    """Tests for doctor disk space check."""

    def test_doctor_disk_check_failure(self, tmp_path: Path) -> None:
        """Test doctor when disk check fails."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.prompts.get_git_config", return_value=("T", "t@t")),
            patch("ccbox.cli.image_exists", return_value=False),
            patch("ccbox.cli.prompts.detect_project_type") as mock_detect,
            patch("shutil.disk_usage", side_effect=OSError("Cannot check")),
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
        """Test update with no flags rebuilds MINIMAL + BASE."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.build_image", return_value=True) as mock_build,
        ):
            result = runner.invoke(cli, ["update"])
            assert result.exit_code == 0
            # Default: rebuild minimal + base from scratch
            assert mock_build.call_count == 2
            mock_build.assert_any_call(LanguageStack.MINIMAL)
            mock_build.assert_any_call(LanguageStack.BASE)


class TestChdirOption:
    """Tests for --chdir/-C option."""

    def test_chdir_option_changes_directory(self, tmp_path: Path) -> None:
        """Test that --chdir changes working directory before running."""
        runner = CliRunner()

        # Create a project marker in tmp_path
        (tmp_path / "go.mod").touch()

        captured_cwd = []

        def capture_cwd() -> object:
            captured_cwd.append(Path.cwd())
            from ccbox.config import Config

            return Config()

        with (
            patch("ccbox.cli.run.check_docker", return_value=True),
            patch("ccbox.cli.run.prune_stale_resources", return_value={}),
            patch("ccbox.cli.run.setup_git_config", side_effect=capture_cwd),
            patch("ccbox.cli.run.detect_project_type") as mock_detect,
            patch("ccbox.cli.run.project_image_exists", return_value=False),
            patch("ccbox.cli.run.resolve_stack", return_value=None),  # User cancels
            runner.isolated_filesystem(),
        ):
            from ccbox.detector import DetectionResult

            mock_detect.return_value = DetectionResult([], LanguageStack.BASE)
            runner.invoke(cli, ["-C", str(tmp_path)])

            # Should have changed to tmp_path before running
            assert len(captured_cwd) > 0
            assert captured_cwd[0] == tmp_path

    def test_chdir_option_with_invalid_path(self) -> None:
        """Test --chdir with non-existent path shows error."""
        runner = CliRunner()
        result = runner.invoke(cli, ["-C", "/nonexistent/path/12345"])
        assert result.exit_code != 0
        assert "does not exist" in result.output.lower() or "invalid" in result.output.lower()

    def test_chdir_option_with_file_not_directory(self, tmp_path: Path) -> None:
        """Test --chdir with file (not directory) shows error."""
        test_file = tmp_path / "file.txt"
        test_file.touch()

        runner = CliRunner()
        result = runner.invoke(cli, ["-C", str(test_file)])
        assert result.exit_code != 0

    def test_chdir_short_option(self, tmp_path: Path) -> None:
        """Test -C short option works."""
        runner = CliRunner()

        with (
            patch("ccbox.cli.run.check_docker", return_value=True),
            patch("ccbox.cli.run.prune_stale_resources", return_value={}),
            patch("ccbox.cli.run.setup_git_config") as mock_setup_git,
            patch("ccbox.cli.run.detect_project_type") as mock_detect,
            patch("ccbox.cli.run.detect_dependencies", return_value=[]),
            patch("ccbox.cli.run.project_image_exists", return_value=True),
            patch("ccbox.cli.run.get_project_image_name", return_value="ccbox-test:base"),
            patch("ccbox.cli.run.get_docker_run_cmd", return_value=["echo", "test"]),
            patch("ccbox.cli.run.sleepctl.run_with_sleep_inhibition", return_value=0),
        ):
            from ccbox.config import Config
            from ccbox.detector import DetectionResult

            mock_setup_git.return_value = Config()
            mock_detect.return_value = DetectionResult(
                detected_languages=[],
                recommended_stack=LanguageStack.BASE,
            )
            result = runner.invoke(cli, ["-C", str(tmp_path)])
            # Should run without CLI error
            assert result.exit_code == 0

    def test_help_shows_chdir_option(self) -> None:
        """Test --help shows --chdir/-C option."""
        runner = CliRunner()
        result = runner.invoke(cli, ["--help"])
        assert result.exit_code == 0
        assert "--chdir" in result.output or "-C" in result.output


class TestInteractiveStackSelection:
    """Tests for full interactive stack selection flow."""

    def test_run_interactive_full_flow(self, tmp_path: Path) -> None:
        """Test full interactive run with stack selection."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.run.check_docker", return_value=True),
            patch("ccbox.cli.run.prune_stale_resources", return_value={}),
            patch("ccbox.cli.run.setup_git_config") as mock_setup_git,
            patch("ccbox.cli.run.detect_project_type") as mock_detect,
            patch("ccbox.cli.run.detect_dependencies", return_value=[]),
            patch("ccbox.cli.run.project_image_exists", return_value=True),
            patch("ccbox.cli.run.get_project_image_name", return_value="ccbox-test:base"),
            patch("ccbox.cli.run.get_docker_run_cmd", return_value=["echo", "test"]),
            patch("ccbox.cli.run.sleepctl.run_with_sleep_inhibition", return_value=0),
        ):
            from ccbox.config import Config
            from ccbox.detector import DetectionResult

            mock_setup_git.return_value = Config()
            mock_detect.return_value = DetectionResult(
                recommended_stack=LanguageStack.BASE,
                detected_languages=["python"],
            )
            result = runner.invoke(cli, ["--path", str(tmp_path)])
            assert result.exit_code == 0


class TestBenchmarkCLIOptions:
    """Tests for benchmark-related CLI options (prompt, yes, model, quiet)."""

    def test_get_docker_run_cmd_with_prompt(self) -> None:
        """Test --prompt/-p passes prompt as positional arg to claude command."""
        claude_dir = Path.home() / ".claude-test-prompt"
        claude_dir.mkdir(exist_ok=True)

        try:
            config = Config(claude_config_dir=str(claude_dir))
            cmd = get_docker_run_cmd(
                config,
                Path("/project/test"),
                "test",
                LanguageStack.BASE,
                prompt="Build a REST API",
            )
            # Prompt enables --print mode and is passed as positional arg
            assert "--print" in cmd
            assert "Build a REST API" in cmd
            # Prompt should be last (positional arg after all flags)
            assert cmd[-1] == "Build a REST API"
            # --print should come after image name
            image_idx = cmd.index("ccbox:base")
            print_idx = cmd.index("--print")
            assert print_idx > image_idx
        finally:
            claude_dir.rmdir()

    def test_get_docker_run_cmd_with_model(self) -> None:
        """Test --model passes model to claude command."""
        claude_dir = Path.home() / ".claude-test-model"
        claude_dir.mkdir(exist_ok=True)

        try:
            config = Config(claude_config_dir=str(claude_dir))
            cmd = get_docker_run_cmd(
                config,
                Path("/project/test"),
                "test",
                LanguageStack.BASE,
                model="opus",
            )
            assert "--model" in cmd
            assert "opus" in cmd
            # --model should come after image name
            image_idx = cmd.index("ccbox:base")
            model_idx = cmd.index("--model")
            assert model_idx > image_idx
        finally:
            claude_dir.rmdir()

    def test_get_docker_run_cmd_with_quiet(self) -> None:
        """Test --quiet/-q passes --print to claude command."""
        claude_dir = Path.home() / ".claude-test-quiet"
        claude_dir.mkdir(exist_ok=True)

        try:
            config = Config(claude_config_dir=str(claude_dir))
            cmd = get_docker_run_cmd(
                config,
                Path("/project/test"),
                "test",
                LanguageStack.BASE,
                quiet=True,
            )
            # quiet maps to --print in claude CLI
            assert "--print" in cmd
            # --print should come after image name
            image_idx = cmd.index("ccbox:base")
            print_idx = cmd.index("--print")
            assert print_idx > image_idx
        finally:
            claude_dir.rmdir()

    def test_get_docker_run_cmd_with_all_benchmark_options(self) -> None:
        """Test all benchmark options together."""
        claude_dir = Path.home() / ".claude-test-all"
        claude_dir.mkdir(exist_ok=True)

        try:
            config = Config(claude_config_dir=str(claude_dir))
            cmd = get_docker_run_cmd(
                config,
                Path("/project/test"),
                "test",
                LanguageStack.BASE,
                prompt="Test prompt",
                model="sonnet",
                quiet=True,
            )
            # Verify exact argument positions in command list
            assert "--model" in cmd
            model_idx = cmd.index("--model")
            assert cmd[model_idx + 1] == "sonnet"
            assert "--print" in cmd
            # Prompt is positional arg (last)
            assert cmd[-1] == "Test prompt"
        finally:
            claude_dir.rmdir()

    def test_cli_help_shows_benchmark_options(self) -> None:
        """Test --help shows all benchmark-related options."""
        runner = CliRunner()
        result = runner.invoke(cli, ["--help"])
        assert result.exit_code == 0
        assert "--prompt" in result.output or "-p" in result.output
        assert "--model" in result.output or "-m" in result.output
        assert "--quiet" in result.output or "-q" in result.output

    def test_prompt_with_special_characters(self) -> None:
        """Test --prompt handles special characters correctly."""
        claude_dir = Path.home() / ".claude-test-special"
        claude_dir.mkdir(exist_ok=True)
        try:
            config = Config(claude_config_dir=str(claude_dir))
            special_prompt = "Test \"quotes\" and 'apostrophes' & symbols <>"
            cmd = get_docker_run_cmd(
                config,
                Path("/project/test"),
                "test",
                LanguageStack.BASE,
                prompt=special_prompt,
            )
            # Prompt is positional arg (last element)
            assert cmd[-1] == special_prompt
            assert "--print" in cmd
        finally:
            claude_dir.rmdir()

    def test_prompt_empty_string_filtered(self) -> None:
        """Test --prompt with empty string is filtered out (not passed to Claude)."""
        claude_dir = Path.home() / ".claude-test-empty"
        claude_dir.mkdir(exist_ok=True)
        try:
            config = Config(claude_config_dir=str(claude_dir))
            cmd = get_docker_run_cmd(
                config,
                Path("/project/test"),
                "test",
                LanguageStack.BASE,
                prompt="",  # Empty string
            )
            # Empty prompt is falsy, so --print and prompt should NOT be added
            assert "--print" not in cmd
            # Image name should be in command
            assert "ccbox:base" in cmd
            # Empty string should not be added as argument
            assert "" not in cmd
        finally:
            claude_dir.rmdir()

    def test_model_passed_as_is(self) -> None:
        """Test --model is passed directly to Claude without validation."""
        claude_dir = Path.home() / ".claude-test-model-custom"
        claude_dir.mkdir(exist_ok=True)
        try:
            config = Config(claude_config_dir=str(claude_dir))
            # Test arbitrary model name (no validation)
            cmd = get_docker_run_cmd(
                config,
                Path("/project/test"),
                "test",
                LanguageStack.BASE,
                model="custom-model-name",
            )
            assert "--model" in cmd
            model_idx = cmd.index("--model")
            assert cmd[model_idx + 1] == "custom-model-name"
        finally:
            claude_dir.rmdir()

    def test_prompt_exceeds_max_length(self) -> None:
        """Test --prompt rejects prompts exceeding 5000 characters."""
        runner = CliRunner()
        long_prompt = "a" * 5001  # Exceeds max length
        with patch("ccbox.cli.check_docker", return_value=True):
            result = runner.invoke(cli, ["--prompt", long_prompt])
            assert result.exit_code == 1
            assert "5000 characters or less" in strip_ansi(result.output)

    def test_prompt_whitespace_stripped(self) -> None:
        """Test prompt as positional argument is stripped."""
        claude_dir = Path.home() / ".claude-test-whitespace"
        claude_dir.mkdir(exist_ok=True)
        try:
            config = Config(claude_config_dir=str(claude_dir))
            # Note: Stripping happens in CLI validation, so we test at that level
            # The get_docker_run_cmd receives already-stripped prompt
            stripped_prompt = "Test prompt"
            cmd = get_docker_run_cmd(
                config,
                Path("/project/test"),
                "test",
                LanguageStack.BASE,
                prompt=stripped_prompt,
            )
            # Prompt is passed as positional argument (last element)
            assert "Test prompt" in cmd
            assert cmd[-1] == "Test prompt"
            # Verify --print flag is present (required for prompt mode)
            assert "--print" in cmd
        finally:
            claude_dir.rmdir()

    def test_bypass_permissions_always_added(self) -> None:
        """Test --dangerously-skip-permissions is always added to Claude args.

        This flag MUST be in the docker run command (not just entrypoint) to ensure
        bypass works even with old/cached images that may have different entrypoints.
        """
        claude_dir = Path.home() / ".claude-test-bypass"
        claude_dir.mkdir(exist_ok=True)
        try:
            config = Config(claude_config_dir=str(claude_dir))
            # Test without any special options
            cmd = get_docker_run_cmd(
                config,
                Path("/project/test"),
                "test",
                LanguageStack.BASE,
            )
            assert "--dangerously-skip-permissions" in cmd

            # Test with prompt
            cmd_with_prompt = get_docker_run_cmd(
                config,
                Path("/project/test"),
                "test",
                LanguageStack.BASE,
                prompt="test",
            )
            assert "--dangerously-skip-permissions" in cmd_with_prompt

            # Test with bare mode
            cmd_bare = get_docker_run_cmd(
                config,
                Path("/project/test"),
                "test",
                LanguageStack.BASE,
                bare=True,
            )
            assert "--dangerously-skip-permissions" in cmd_bare
        finally:
            claude_dir.rmdir()


class TestCleanupCCBoxDanglingImages:
    """Tests for cleanup_ccbox_dangling_images() function.

    This function is called after each build to prevent disk accumulation
    from intermediate build layers. It ONLY removes dangling images whose
    parent chain includes a ccbox image - non-ccbox dangling images are preserved.
    """

    def test_no_ccbox_images_returns_zero(self) -> None:
        """When no ccbox images exist, nothing should be removed."""
        with patch("ccbox.cli.cleanup.subprocess.run") as mock_run:
            # Mock: no ccbox images found
            ccbox_result = MagicMock()
            ccbox_result.returncode = 0
            ccbox_result.stdout = ""
            mock_run.return_value = ccbox_result

            result = cleanup_ccbox_dangling_images()
            assert result == 0
            # Only one call made (to get ccbox images)
            assert mock_run.call_count == 1

    def test_no_dangling_images_returns_zero(self) -> None:
        """When ccbox images exist but no dangling images, nothing removed."""
        with patch("ccbox.cli.cleanup.subprocess.run") as mock_run:

            def side_effect(*args: object, **kwargs: object) -> MagicMock:
                cmd = args[0]
                result = MagicMock()
                result.returncode = 0

                if "images" in cmd and "ccbox" in cmd:
                    # ccbox images exist
                    result.stdout = "abc123\ndef456"
                elif "dangling=true" in str(cmd):
                    # No dangling images
                    result.stdout = ""
                return result

            mock_run.side_effect = side_effect

            result = cleanup_ccbox_dangling_images()
            assert result == 0

    def test_dangling_without_ccbox_parent_not_removed(self) -> None:
        """Dangling images not from ccbox should NOT be removed."""
        with patch("ccbox.cli.cleanup.subprocess.run") as mock_run:

            def side_effect(*args: object, **kwargs: object) -> MagicMock:
                cmd = args[0]
                result = MagicMock()
                result.returncode = 0

                if "images" in cmd and "--format" in cmd:
                    # ccbox images
                    result.stdout = "ccbox111\nccbox222"
                elif "dangling=true" in str(cmd):
                    # Dangling image exists
                    result.stdout = "dangle999"
                elif "history" in cmd:
                    # History shows NO ccbox parent (different IDs)
                    result.stdout = "other111\nother222\nother333"
                return result

            mock_run.side_effect = side_effect

            result = cleanup_ccbox_dangling_images()
            # Nothing removed because dangling has no ccbox parent
            assert result == 0
            # No docker rmi calls made
            for call in mock_run.call_args_list:
                assert "rmi" not in str(call)

    def test_dangling_with_ccbox_parent_removed(self) -> None:
        """Dangling images from ccbox should be removed."""
        with patch("ccbox.cli.cleanup.subprocess.run") as mock_run:

            def side_effect(*args: object, **kwargs: object) -> MagicMock:
                cmd = args[0]
                result = MagicMock()
                result.returncode = 0

                if "images" in cmd and "--format" in cmd:
                    # ccbox images
                    result.stdout = "ccbox111\nccbox222"
                elif "dangling=true" in str(cmd):
                    # Dangling image exists
                    result.stdout = "dangle999"
                elif "history" in cmd:
                    # History INCLUDES a ccbox parent ID
                    result.stdout = "layer1\nccbox111\nlayer2"
                elif "rmi" in cmd:
                    # Successful removal
                    result.returncode = 0
                return result

            mock_run.side_effect = side_effect

            result = cleanup_ccbox_dangling_images()
            # One dangling image removed
            assert result == 1
            # Verify rmi was called
            rmi_calls = [c for c in mock_run.call_args_list if "rmi" in str(c)]
            assert len(rmi_calls) == 1

    def test_timeout_returns_zero(self) -> None:
        """Timeout should be handled gracefully, returning 0."""
        import subprocess

        with patch("ccbox.cli.cleanup.subprocess.run") as mock_run:
            mock_run.side_effect = subprocess.TimeoutExpired(cmd="docker", timeout=30)

            result = cleanup_ccbox_dangling_images()
            assert result == 0

    def test_docker_not_found_returns_zero(self) -> None:
        """FileNotFoundError (docker not installed) handled gracefully."""
        with patch("ccbox.cli.cleanup.subprocess.run") as mock_run:
            mock_run.side_effect = FileNotFoundError("docker not found")

            result = cleanup_ccbox_dangling_images()
            assert result == 0


class TestPromptWhitespaceValidation:
    """Tests for prompt whitespace-only validation."""

    def test_prompt_whitespace_only_rejected(self) -> None:
        """Whitespace-only prompt should be rejected."""
        runner = CliRunner()
        with patch("ccbox.cli.check_docker", return_value=True):
            result = runner.invoke(cli, ["--prompt", "   "])
            assert result.exit_code == 1
            assert "empty or whitespace-only" in result.output

    def test_prompt_tabs_and_newlines_rejected(self) -> None:
        """Tabs and newlines only should be rejected."""
        runner = CliRunner()
        with patch("ccbox.cli.check_docker", return_value=True):
            result = runner.invoke(cli, ["--prompt", "\t\n  \t"])
            assert result.exit_code == 1
            assert "empty or whitespace-only" in result.output


class TestProjectImageNameValidation:
    """Tests for project image name length validation."""

    def test_long_project_name_truncated(self) -> None:
        """Very long project names should be truncated to fit Docker limits."""
        from ccbox.config import LanguageStack

        # 200-char project name
        long_name = "a" * 200
        result = get_project_image_name(long_name, LanguageStack.BASE)

        # Result should be under 128 chars total
        assert len(result) <= 128
        assert result.startswith("ccbox-")
        assert result.endswith(":base")


class TestExtractedHelperFunctions:
    """Tests for extracted helper functions (refactored from cleanup_ccbox_dangling_images)."""

    def test_get_ccbox_image_ids_success(self) -> None:
        """Test getting ccbox image IDs successfully."""
        with patch("ccbox.cli.cleanup.docker.get_image_ids") as mock_get:
            mock_get.return_value = {"abc123", "def456", "ghi789"}

            result = _get_ccbox_image_ids()

            assert result == {"abc123", "def456", "ghi789"}
            mock_get.assert_called_once_with("ccbox")

    def test_get_ccbox_image_ids_empty(self) -> None:
        """Test empty result when no ccbox images."""
        with patch("ccbox.cli.cleanup.docker.get_image_ids") as mock_get:
            mock_get.return_value = set()

            result = _get_ccbox_image_ids()

            assert result == set()

    def test_get_ccbox_image_ids_failure(self) -> None:
        """Test graceful handling of docker command failure."""
        with patch("ccbox.cli.cleanup.docker.get_image_ids") as mock_get:
            mock_get.return_value = set()

            result = _get_ccbox_image_ids()

            assert result == set()

    def test_get_dangling_image_ids_success(self) -> None:
        """Test getting dangling image IDs successfully."""
        with patch("ccbox.cli.cleanup.docker.get_dangling_image_ids") as mock_get:
            mock_get.return_value = ["dangle1", "dangle2"]

            result = _get_dangling_image_ids()

            assert result == ["dangle1", "dangle2"]
            mock_get.assert_called_once()

    def test_get_dangling_image_ids_empty(self) -> None:
        """Test empty result when no dangling images."""
        with patch("ccbox.cli.cleanup.docker.get_dangling_image_ids") as mock_get:
            mock_get.return_value = []

            result = _get_dangling_image_ids()

            assert result == []

    def test_image_has_ccbox_parent_true(self) -> None:
        """Test detecting ccbox parent in image history."""
        with patch("ccbox.cli.cleanup.docker.image_has_parent") as mock_has:
            mock_has.return_value = True

            result = _image_has_ccbox_parent("test-image", {"ccbox123", "ccbox456"})

            assert result is True
            mock_has.assert_called_once_with("test-image", {"ccbox123", "ccbox456"})

    def test_image_has_ccbox_parent_false(self) -> None:
        """Test no ccbox parent detected when history has no match."""
        with patch("ccbox.cli.cleanup.docker.image_has_parent") as mock_has:
            mock_has.return_value = False

            result = _image_has_ccbox_parent("test-image", {"ccbox123", "ccbox456"})

            assert result is False


class TestSharedCleanupHelpers:
    """Tests for shared cleanup helper functions."""

    def testremove_ccbox_containers_success(self) -> None:
        """Test removing ccbox containers successfully."""
        with patch("ccbox.cli.cleanup.subprocess.run") as mock_run:

            def side_effect(*args: object, **kwargs: object) -> MagicMock:
                cmd = args[0]
                result = MagicMock()
                result.returncode = 0
                if "ps" in cmd:
                    result.stdout = "ccbox-project1\nccbox-project2"
                return result

            mock_run.side_effect = side_effect

            removed = remove_ccbox_containers()

            assert removed == 2
            # Verify docker rm was called for each container
            rm_calls = [c for c in mock_run.call_args_list if "rm" in c[0][0]]
            assert len(rm_calls) == 2

    def testremove_ccbox_containers_none(self) -> None:
        """Test when no containers to remove."""
        with patch("ccbox.cli.cleanup.subprocess.run") as mock_run:
            mock_result = MagicMock()
            mock_result.returncode = 0
            mock_result.stdout = ""
            mock_run.return_value = mock_result

            removed = remove_ccbox_containers()

            assert removed == 0

    def testremove_ccbox_images_success(self) -> None:
        """Test removing ccbox images successfully."""
        with patch("ccbox.cli.cleanup.subprocess.run") as mock_run:

            def side_effect(*args: object, **kwargs: object) -> MagicMock:
                cmd = args[0]
                result = MagicMock()

                if "docker" in cmd and "rmi" in cmd:
                    # Stack image removal
                    result.returncode = 0
                elif "docker" in cmd and "images" in cmd:
                    # List images for project images
                    result.returncode = 0
                    result.stdout = "ccbox-myproject:base\nccbox-other:go\nunrelated:latest"
                else:
                    result.returncode = 0

                return result

            mock_run.side_effect = side_effect

            removed = remove_ccbox_images()

            # Should have removed stack images + project images
            assert removed >= 2  # At least 2 project images

    def testremove_ccbox_images_timeout_handled(self) -> None:
        """Test timeout handling in image removal."""
        import subprocess

        with patch("ccbox.cli.cleanup.subprocess.run") as mock_run:
            mock_run.side_effect = subprocess.TimeoutExpired(cmd="docker", timeout=30)

            removed = remove_ccbox_images()

            assert removed == 0


class TestPruneIntegration:
    """Integration tests for prune workflow."""

    def test_prune_calls_helpers_in_order(self) -> None:
        """Test prune command calls cleanup helpers in correct sequence."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.remove_ccbox_containers", return_value=3) as mock_containers,
            patch("ccbox.cli.remove_ccbox_images", return_value=5) as mock_images,
            patch("ccbox.cli.clean_temp_files", return_value=1) as mock_temp,
        ):
            result = runner.invoke(cli, ["prune", "-f"])

            # Verify order: containers first, then images
            assert mock_containers.called
            assert mock_images.called
            assert mock_temp.called

            # Verify success
            assert result.exit_code == 0
            output = strip_ansi(result.output)
            assert "Deep clean complete" in output
            assert "3 container(s)" in output
            assert "5 image(s)" in output

    def test_prune_handles_empty_state(self) -> None:
        """Test prune handles case where nothing to remove."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.remove_ccbox_containers", return_value=0),
            patch("ccbox.cli.remove_ccbox_images", return_value=0),
            patch("ccbox.cli.clean_temp_files", return_value=0),
        ):
            result = runner.invoke(cli, ["prune", "-f"])

            assert result.exit_code == 0
            assert "Nothing to remove" in result.output

    def test_clean_uses_shared_helpers(self) -> None:
        """Test clean command uses shared helper functions."""
        runner = CliRunner()
        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.remove_ccbox_containers", return_value=2) as mock_containers,
            patch("ccbox.cli.remove_ccbox_images", return_value=3) as mock_images,
        ):
            result = runner.invoke(cli, ["clean", "-f"])

            assert mock_containers.called
            assert mock_images.called
            assert result.exit_code == 0
            assert "Cleanup complete" in result.output
