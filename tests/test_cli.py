"""Tests for ccbox CLI."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from click.testing import CliRunner

from ccbox.cli import check_docker, cli, get_project_name, run_command
from ccbox.config import (
    Config,
    LanguageStack,
    RuntimeMode,
    get_claude_config_dir,
    get_config_dir,
    get_config_path,
    get_container_name,
    get_image_name,
    load_config,
    save_config,
)
from ccbox.detector import detect_project_type, get_stack_for_language
from ccbox.generator import (
    generate_compose,
    generate_dockerfile,
    generate_entrypoint,
    get_language_packages,
    get_optional_tools,
    get_template,
    render_template,
)


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
        content = get_template("Dockerfile.template")
        assert "FROM node:slim" in content
        assert "claude" in content.lower()

    def test_compose_template_exists(self) -> None:
        """Test that compose template exists."""
        content = get_template("compose.yml.template")
        assert "services:" in content
        assert "volumes:" in content

    def test_entrypoint_template_exists(self) -> None:
        """Test that entrypoint template exists."""
        content = get_template("entrypoint.sh.template")
        assert "#!/bin/bash" in content
        assert "NODE_OPTIONS" in content


class TestGenerator:
    """Tests for template generation functions."""

    def test_render_template(self) -> None:
        """Test template rendering with context."""
        content = render_template(
            "Dockerfile.template",
            {
                "extra_languages": "# Test",
                "optional_tools": "# None",
                "ram_percent": 75,
                "cpu_percent": 100,
            },
        )
        assert "FROM node:slim" in content
        assert "# Test" in content

    def test_get_language_packages_node(self) -> None:
        """Test language packages for Node stack."""
        packages = get_language_packages(LanguageStack.NODE)
        assert "extra_languages" in packages
        assert "Node.js only" in packages["extra_languages"]

    def test_get_language_packages_python(self) -> None:
        """Test language packages for Python stack."""
        packages = get_language_packages(LanguageStack.NODE_PYTHON)
        assert "python3" in packages["extra_languages"].lower()

    def test_get_language_packages_go(self) -> None:
        """Test language packages for Go stack."""
        packages = get_language_packages(LanguageStack.NODE_GO)
        assert "go" in packages["extra_languages"].lower()

    def test_get_language_packages_rust(self) -> None:
        """Test language packages for Rust stack."""
        packages = get_language_packages(LanguageStack.NODE_RUST)
        assert "rust" in packages["extra_languages"].lower()

    def test_get_language_packages_java(self) -> None:
        """Test language packages for Java stack."""
        packages = get_language_packages(LanguageStack.NODE_JAVA)
        assert "openjdk" in packages["extra_languages"].lower()

    def test_get_language_packages_dotnet(self) -> None:
        """Test language packages for .NET stack."""
        packages = get_language_packages(LanguageStack.NODE_DOTNET)
        assert "dotnet" in packages["extra_languages"].lower()

    def test_get_language_packages_universal(self) -> None:
        """Test language packages for Universal stack."""
        packages = get_language_packages(LanguageStack.UNIVERSAL)
        assert "python" in packages["extra_languages"].lower()
        assert "go" in packages["extra_languages"].lower()
        assert "rust" in packages["extra_languages"].lower()

    def test_get_language_packages_custom(self) -> None:
        """Test language packages for Custom stack."""
        packages = get_language_packages(LanguageStack.CUSTOM)
        assert "Custom stack" in packages["extra_languages"]

    def test_get_optional_tools_none(self) -> None:
        """Test optional tools with nothing installed."""
        config = Config()
        tools = get_optional_tools(config)
        assert "No optional tools" in tools

    def test_get_optional_tools_cco(self) -> None:
        """Test optional tools with CCO."""
        config = Config(install_cco=True)
        tools = get_optional_tools(config)
        assert "ClaudeCodeOptimizer" in tools

    def test_get_optional_tools_gh(self) -> None:
        """Test optional tools with GitHub CLI."""
        config = Config(install_gh=True)
        tools = get_optional_tools(config)
        assert "GitHub CLI" in tools

    def test_get_optional_tools_gitleaks(self) -> None:
        """Test optional tools with Gitleaks."""
        config = Config(install_gitleaks=True)
        tools = get_optional_tools(config)
        assert "Gitleaks" in tools

    def test_generate_dockerfile(self) -> None:
        """Test Dockerfile generation."""
        config = Config()
        dockerfile = generate_dockerfile(config, LanguageStack.NODE)
        assert "FROM node:slim" in dockerfile
        assert "claude" in dockerfile.lower()

    def test_generate_compose(self, tmp_path: Path) -> None:
        """Test compose file generation."""
        config = Config(git_name="Test", git_email="test@test.com")
        compose = generate_compose(
            config,
            tmp_path,
            "test-project",
            LanguageStack.NODE,
            tmp_path / "build",
        )
        assert "services:" in compose
        assert "test-project" in compose
        assert "Test" in compose

    def test_generate_compose_with_extras(self, tmp_path: Path) -> None:
        """Test compose file generation with extra settings."""
        config = Config(
            git_name="Test",
            git_email="test@test.com",
            extra_volumes=["/host:/container"],
            extra_env={"MY_VAR": "value"},
            docker_network="mynet",
        )
        compose = generate_compose(
            config,
            tmp_path,
            "test-project",
            LanguageStack.NODE,
            tmp_path / "build",
        )
        assert "/host:/container" in compose
        assert "MY_VAR=value" in compose
        assert "mynet" in compose

    def test_generate_entrypoint(self) -> None:
        """Test entrypoint script generation."""
        entrypoint = generate_entrypoint()
        assert "#!/bin/bash" in entrypoint
        assert "NODE_OPTIONS" in entrypoint


class TestConfigFunctions:
    """Tests for config utility functions."""

    def test_get_config_dir(self) -> None:
        """Test config directory path."""
        config_dir = get_config_dir()
        assert ".ccbox" in str(config_dir)

    def test_get_config_path(self) -> None:
        """Test config file path."""
        config_path = get_config_path()
        assert "config.json" in str(config_path)

    def test_get_claude_config_dir(self) -> None:
        """Test Claude config directory expansion."""
        config = Config(claude_config_dir="~/.claude")
        claude_dir = get_claude_config_dir(config)
        assert ".claude" in str(claude_dir)
        assert "~" not in str(claude_dir)

    def test_save_and_load_config(self, tmp_path: Path) -> None:
        """Test config save and load cycle."""
        with patch("ccbox.config.get_config_dir", return_value=tmp_path):
            config = Config(git_name="SaveTest", git_email="save@test.com")
            save_config(config)
            loaded = load_config()
            assert loaded.git_name == "SaveTest"
            assert loaded.git_email == "save@test.com"

    def test_load_config_invalid_json(self, tmp_path: Path) -> None:
        """Test loading invalid JSON config."""
        with patch("ccbox.config.get_config_path", return_value=tmp_path / "config.json"):
            (tmp_path / "config.json").write_text("invalid json {{{")
            config = load_config()
            # Should return defaults
            assert config.ram_percent == 75


class TestDetectorFunctions:
    """Tests for detector utility functions."""

    def test_get_stack_for_language_node(self) -> None:
        """Test stack mapping for Node."""
        assert get_stack_for_language("node") == LanguageStack.NODE

    def test_get_stack_for_language_python(self) -> None:
        """Test stack mapping for Python."""
        assert get_stack_for_language("python") == LanguageStack.NODE_PYTHON

    def test_get_stack_for_language_unknown(self) -> None:
        """Test stack mapping for unknown language."""
        assert get_stack_for_language("unknown") is None

    def test_detect_java_project(self, tmp_path: Path) -> None:
        """Test detection of Java project."""
        (tmp_path / "pom.xml").write_text("")
        result = detect_project_type(tmp_path)
        assert "java" in result.detected_languages
        assert result.recommended_stack == LanguageStack.NODE_JAVA

    def test_detect_dotnet_project(self, tmp_path: Path) -> None:
        """Test detection of .NET project."""
        (tmp_path / "test.csproj").write_text("")
        result = detect_project_type(tmp_path)
        assert "dotnet" in result.detected_languages
        assert result.recommended_stack == LanguageStack.NODE_DOTNET


class TestCLIFunctions:
    """Tests for CLI utility functions."""

    def test_get_project_name(self, tmp_path: Path) -> None:
        """Test project name extraction."""
        name = get_project_name(tmp_path)
        assert name == tmp_path.name

    @patch("ccbox.cli.subprocess.run")
    def test_check_docker_available(self, mock_run: MagicMock) -> None:
        """Test Docker availability check."""
        mock_run.return_value = MagicMock(returncode=0)
        assert check_docker() is True

    @patch("ccbox.cli.subprocess.run")
    def test_check_docker_not_available(self, mock_run: MagicMock) -> None:
        """Test Docker not available."""
        mock_run.return_value = MagicMock(returncode=1)
        assert check_docker() is False

    @patch("ccbox.cli.subprocess.run")
    def test_check_docker_not_found(self, mock_run: MagicMock) -> None:
        """Test Docker not found."""
        mock_run.side_effect = FileNotFoundError()
        assert check_docker() is False

    @patch("ccbox.cli.subprocess.run")
    def test_run_command_success(self, mock_run: MagicMock) -> None:
        """Test successful command execution."""
        mock_run.return_value = MagicMock(returncode=0, stdout="output")
        result = run_command(["echo", "test"], capture=True)
        assert result.returncode == 0

    def test_status_command(self, runner: CliRunner) -> None:
        """Test status command."""
        with patch("ccbox.cli.check_docker", return_value=False):
            result = runner.invoke(cli, ["status"])
            assert result.exit_code == 0
            assert "ccbox" in result.output.lower()

    def test_config_command_show(self, runner: CliRunner) -> None:
        """Test config show command."""
        result = runner.invoke(cli, ["config", "--show"])
        assert result.exit_code == 0

    @patch("ccbox.cli.check_docker")
    def test_clean_no_docker(self, mock_docker: MagicMock, runner: CliRunner) -> None:
        """Test clean command without Docker."""
        mock_docker.return_value = False
        result = runner.invoke(cli, ["clean"])
        assert "not available" in result.output.lower()
