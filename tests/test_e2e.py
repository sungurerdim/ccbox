"""End-to-end integration tests for ccbox.

These tests verify the complete workflow logic with mocked Docker calls.
They test the integration between components without requiring actual Docker.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from click.testing import CliRunner

from ccbox.cli import cli


class TestE2EPythonProject:
    """E2E tests for Python project workflow."""

    def test_python_project_full_workflow(self, tmp_path: Path) -> None:
        """Test complete workflow for a Python project."""
        # Setup: Create Python project markers
        (tmp_path / "pyproject.toml").write_text('[project]\nname = "test"')
        (tmp_path / "src").mkdir()
        (tmp_path / "src" / "main.py").write_text("print('hello')")

        runner = CliRunner()

        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.get_git_config", return_value=("Test User", "test@test.com")),
            patch("ccbox.cli.image_exists", return_value=True),
            patch("ccbox.cli._project_image_exists", return_value=False),
            patch("ccbox.cli.build_image", return_value=True),
            patch("ccbox.cli.detect_dependencies", return_value=[]),
            patch("ccbox.sleepctl.run_with_sleep_inhibition", return_value=0) as mock_run,
        ):
            result = runner.invoke(
                cli,
                ["-s", "base", "-p", str(tmp_path), "-y"],
            )

            assert result.exit_code == 0
            # Verify run was called
            assert mock_run.called
            # Verify command includes project path mount
            cmd = mock_run.call_args[0][0]
            assert any(str(tmp_path.name) in arg for arg in cmd)

    def test_python_project_with_dependencies(self, tmp_path: Path) -> None:
        """Test workflow with dependency detection."""
        # Setup: Create Python project with requirements
        (tmp_path / "requirements.txt").write_text("click>=8.0\nrich>=13.0")
        (tmp_path / "main.py").write_text("import click")

        runner = CliRunner()

        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.get_git_config", return_value=("", "")),
            patch("ccbox.cli.image_exists", return_value=True),
            patch("ccbox.cli._project_image_exists", return_value=False),
            patch("ccbox.cli._build_project_image", return_value="ccbox-test:base") as mock_build,
            patch("ccbox.sleepctl.run_with_sleep_inhibition", return_value=0),
        ):
            result = runner.invoke(
                cli,
                ["-s", "base", "-p", str(tmp_path), "-y", "--deps"],
            )

            assert result.exit_code == 0
            # Verify project image build was attempted
            assert mock_build.called


class TestE2ENodeProject:
    """E2E tests for Node.js project workflow."""

    def test_node_project_detection_and_run(self, tmp_path: Path) -> None:
        """Test Node.js project is detected and runs correctly."""
        # Setup: Create Node.js project markers
        (tmp_path / "package.json").write_text('{"name": "test", "version": "1.0.0"}')
        (tmp_path / "index.js").write_text("console.log('hello');")

        runner = CliRunner()

        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.get_git_config", return_value=("", "")),
            patch("ccbox.cli.image_exists", return_value=True),
            patch("ccbox.cli._project_image_exists", return_value=False),
            patch("ccbox.cli.build_image", return_value=True),
            patch("ccbox.cli.detect_dependencies") as mock_detect_deps,
            patch("ccbox.sleepctl.run_with_sleep_inhibition", return_value=0),
        ):
            from ccbox.deps import DepsInfo

            mock_detect_deps.return_value = [
                DepsInfo.create(
                    name="npm",
                    files=["package.json"],
                    install_all="npm install",
                    install_prod="npm install --production",
                    has_dev=True,
                    priority=5,
                )
            ]

            result = runner.invoke(
                cli,
                ["-s", "auto", "-p", str(tmp_path), "-y"],
            )

            assert result.exit_code == 0

    def test_node_project_with_yarn(self, tmp_path: Path) -> None:
        """Test Node.js project with yarn lock file."""
        # Setup: Create Node.js project with yarn
        (tmp_path / "package.json").write_text('{"name": "test"}')
        (tmp_path / "yarn.lock").write_text("# yarn lockfile")

        runner = CliRunner()

        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.get_git_config", return_value=("", "")),
            patch("ccbox.cli.image_exists", return_value=True),
            patch("ccbox.cli._project_image_exists", return_value=False),
            patch("ccbox.cli.build_image", return_value=True),
            patch("ccbox.sleepctl.run_with_sleep_inhibition", return_value=0),
        ):
            result = runner.invoke(
                cli,
                ["-s", "base", "-p", str(tmp_path), "-y", "--no-deps"],
            )

            assert result.exit_code == 0


class TestE2EGoProject:
    """E2E tests for Go project workflow."""

    def test_go_project_uses_go_stack(self, tmp_path: Path) -> None:
        """Test Go project auto-selects go stack."""
        # Setup: Create Go project
        (tmp_path / "go.mod").write_text("module example.com/test\n\ngo 1.21")
        (tmp_path / "main.go").write_text("package main\n\nfunc main() {}")

        runner = CliRunner()

        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.get_git_config", return_value=("", "")),
            patch("ccbox.cli.image_exists", return_value=True),
            patch("ccbox.cli._project_image_exists", return_value=False),
            patch("ccbox.cli.build_image", return_value=True),
            patch("ccbox.cli.detect_dependencies", return_value=[]),
            patch("ccbox.sleepctl.run_with_sleep_inhibition", return_value=0) as mock_run,
        ):
            result = runner.invoke(
                cli,
                ["-s", "auto", "-p", str(tmp_path), "-y"],
            )

            assert result.exit_code == 0
            # Check that go stack image is used
            cmd = mock_run.call_args[0][0]
            assert any("ccbox:go" in arg for arg in cmd)


class TestE2ERustProject:
    """E2E tests for Rust project workflow."""

    def test_rust_project_uses_rust_stack(self, tmp_path: Path) -> None:
        """Test Rust project auto-selects rust stack."""
        # Setup: Create Rust project
        (tmp_path / "Cargo.toml").write_text('[package]\nname = "test"\nversion = "0.1.0"')
        (tmp_path / "src").mkdir()
        (tmp_path / "src" / "main.rs").write_text("fn main() {}")

        runner = CliRunner()

        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.get_git_config", return_value=("", "")),
            patch("ccbox.cli.image_exists", return_value=True),
            patch("ccbox.cli._project_image_exists", return_value=False),
            patch("ccbox.cli.build_image", return_value=True),
            patch("ccbox.cli.detect_dependencies", return_value=[]),
            patch("ccbox.sleepctl.run_with_sleep_inhibition", return_value=0) as mock_run,
        ):
            result = runner.invoke(
                cli,
                ["-s", "auto", "-p", str(tmp_path), "-y"],
            )

            assert result.exit_code == 0
            cmd = mock_run.call_args[0][0]
            assert any("ccbox:rust" in arg for arg in cmd)


class TestE2EFullstackProject:
    """E2E tests for fullstack project workflow."""

    def test_fullstack_python_node_uses_web_stack(self, tmp_path: Path) -> None:
        """Test fullstack project with Python + Node uses web stack."""
        # Setup: Create fullstack project
        (tmp_path / "package.json").write_text('{"name": "frontend"}')
        (tmp_path / "requirements.txt").write_text("flask>=2.0")

        runner = CliRunner()

        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.get_git_config", return_value=("", "")),
            patch("ccbox.cli.image_exists", return_value=True),
            patch("ccbox.cli._project_image_exists", return_value=False),
            patch("ccbox.cli.build_image", return_value=True),
            patch("ccbox.cli.detect_dependencies", return_value=[]),
            patch("ccbox.sleepctl.run_with_sleep_inhibition", return_value=0) as mock_run,
        ):
            result = runner.invoke(
                cli,
                ["-s", "auto", "-p", str(tmp_path), "-y"],
            )

            assert result.exit_code == 0
            cmd = mock_run.call_args[0][0]
            # Fullstack projects use web stack
            assert any("ccbox:web" in arg for arg in cmd)


class TestE2EPromptMode:
    """E2E tests for prompt mode (non-interactive)."""

    def test_prompt_mode_passes_prompt_to_claude(self, tmp_path: Path) -> None:
        """Test --prompt flag passes prompt to Claude Code."""
        (tmp_path / "README.md").write_text("# Test")

        runner = CliRunner()

        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.get_git_config", return_value=("", "")),
            patch("ccbox.cli.image_exists", return_value=True),
            patch("ccbox.cli._project_image_exists", return_value=False),
            patch("ccbox.cli.build_image", return_value=True),
            patch("ccbox.cli.detect_dependencies", return_value=[]),
            patch("ccbox.sleepctl.run_with_sleep_inhibition", return_value=0) as mock_run,
        ):
            result = runner.invoke(
                cli,
                [
                    "-s", "base",
                    "-p", str(tmp_path),
                    "-y",
                    "--prompt", "Write a hello world function",
                ],
            )

            assert result.exit_code == 0
            cmd = mock_run.call_args[0][0]
            # Verify prompt is in command
            assert "Write a hello world function" in cmd
            # Verify --print flag is present
            assert "--print" in cmd


class TestE2EBareMode:
    """E2E tests for bare/vanilla mode."""

    def test_bare_mode_sets_environment(self, tmp_path: Path) -> None:
        """Test --bare mode sets CCBOX_BARE_MODE environment."""
        (tmp_path / "test.py").write_text("print('test')")

        runner = CliRunner()

        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.get_git_config", return_value=("", "")),
            patch("ccbox.cli.image_exists", return_value=True),
            patch("ccbox.cli._project_image_exists", return_value=False),
            patch("ccbox.cli.build_image", return_value=True),
            patch("ccbox.cli.detect_dependencies", return_value=[]),
            patch("ccbox.sleepctl.run_with_sleep_inhibition", return_value=0) as mock_run,
        ):
            result = runner.invoke(
                cli,
                ["-s", "base", "-p", str(tmp_path), "-y", "--bare"],
            )

            assert result.exit_code == 0
            cmd = mock_run.call_args[0][0]
            # Verify bare mode flag
            assert any("CCBOX_BARE_MODE=1" in arg for arg in cmd)


class TestE2EBuildOnly:
    """E2E tests for build-only mode."""

    def test_build_only_does_not_run_container(self, tmp_path: Path) -> None:
        """Test --build flag builds but doesn't run container."""
        (tmp_path / "test.py").write_text("pass")

        runner = CliRunner()

        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.get_git_config", return_value=("", "")),
            patch("ccbox.cli.image_exists", return_value=False),
            patch("ccbox.cli._project_image_exists", return_value=False),
            patch("ccbox.cli.build_image", return_value=True) as mock_build,
            patch("ccbox.cli.detect_dependencies", return_value=[]),
            patch("ccbox.sleepctl.run_with_sleep_inhibition") as mock_run,
        ):
            result = runner.invoke(
                cli,
                ["-s", "base", "-p", str(tmp_path), "-y", "-b"],
            )

            assert result.exit_code == 0
            # Build was called
            assert mock_build.called
            # Container was NOT run
            assert not mock_run.called
            # Output indicates build complete
            assert "Build complete" in result.output


class TestE2EErrorHandling:
    """E2E tests for error handling scenarios."""

    def test_docker_not_available(self, tmp_path: Path) -> None:
        """Test graceful handling when Docker is not available."""
        runner = CliRunner()

        with patch("ccbox.cli.check_docker", return_value=False):
            result = runner.invoke(cli, ["-p", str(tmp_path)])

            assert result.exit_code == 1
            assert "Docker" in result.output

    def test_build_failure_exits_with_error(self, tmp_path: Path) -> None:
        """Test build failure results in non-zero exit code."""
        (tmp_path / "test.py").write_text("pass")

        runner = CliRunner()

        with (
            patch("ccbox.cli.check_docker", return_value=True),
            patch("ccbox.cli.get_git_config", return_value=("", "")),
            patch("ccbox.cli.image_exists", return_value=False),
            patch("ccbox.cli._project_image_exists", return_value=False),
            patch("ccbox.cli.build_image", return_value=False),
            patch("ccbox.cli.detect_dependencies", return_value=[]),
        ):
            result = runner.invoke(
                cli,
                ["-s", "base", "-p", str(tmp_path), "-y"],
            )

            assert result.exit_code == 1

    def test_invalid_project_path(self) -> None:
        """Test error on non-existent project path."""
        runner = CliRunner()

        result = runner.invoke(cli, ["-p", "/nonexistent/path/12345"])

        assert result.exit_code != 0
