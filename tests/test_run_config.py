"""Tests for ccbox.run_config module."""

from __future__ import annotations

import pytest

from ccbox.run_config import RunConfig


class TestRunConfig:
    """Tests for RunConfig dataclass."""

    def test_defaults(self) -> None:
        """Default values are set correctly."""
        config = RunConfig()
        assert config.stack_name is None
        assert config.build_only is False
        assert config.path == "."
        assert config.bare is False
        assert config.debug_logs is False
        assert config.deps_mode is None
        assert config.debug == 0
        assert config.prompt is None
        assert config.model is None
        assert config.quiet is False
        assert config.append_system_prompt is None
        assert config.unattended is False
        assert config.prune is True
        assert config.inhibit_sleep is True
        assert config.unrestricted is False

    def test_custom_values(self) -> None:
        """Custom values are set correctly."""
        config = RunConfig(
            stack_name="go",
            build_only=True,
            path="/project",
            bare=True,
            debug_logs=True,
            deps_mode="all",
            debug=2,
            prompt="test prompt",
            model="opus",
            quiet=True,
            append_system_prompt="custom",
            unattended=True,
            prune=False,
            inhibit_sleep=False,
            unrestricted=True,
        )
        assert config.stack_name == "go"
        assert config.build_only is True
        assert config.path == "/project"
        assert config.bare is True
        assert config.debug_logs is True
        assert config.deps_mode == "all"
        assert config.debug == 2
        assert config.prompt == "test prompt"
        assert config.model == "opus"
        assert config.quiet is True
        assert config.append_system_prompt == "custom"
        assert config.unattended is True
        assert config.prune is False
        assert config.inhibit_sleep is False
        assert config.unrestricted is True

    def test_frozen(self) -> None:
        """RunConfig is immutable (frozen)."""
        config = RunConfig()
        with pytest.raises(AttributeError):
            config.path = "/new/path"  # type: ignore[misc]

    def test_hashable(self) -> None:
        """Frozen dataclass is hashable."""
        config = RunConfig(stack_name="base")
        # Should not raise
        hash(config)
        # Can be used in sets/dicts
        _ = {config: "value"}


class TestRunConfigFromCli:
    """Tests for RunConfig.from_cli factory method."""

    def test_defaults(self) -> None:
        """from_cli with no args uses defaults."""
        config = RunConfig.from_cli()
        assert config.stack_name is None
        assert config.build_only is False
        assert config.path == "."
        assert config.unattended is False
        assert config.prune is True
        assert config.inhibit_sleep is True

    def test_yes_maps_to_unattended(self) -> None:
        """--yes flag maps to unattended=True."""
        config = RunConfig.from_cli(yes=True)
        assert config.unattended is True

    def test_no_prune_maps_to_prune_false(self) -> None:
        """--no-prune flag maps to prune=False."""
        config = RunConfig.from_cli(no_prune=True)
        assert config.prune is False

    def test_no_inhibit_sleep_maps(self) -> None:
        """--no-inhibit-sleep flag maps to inhibit_sleep=False."""
        config = RunConfig.from_cli(no_inhibit_sleep=True)
        assert config.inhibit_sleep is False

    def test_stack_renamed(self) -> None:
        """CLI 'stack' arg maps to 'stack_name' field."""
        config = RunConfig.from_cli(stack="rust")
        assert config.stack_name == "rust"

    def test_build_renamed(self) -> None:
        """CLI 'build' arg maps to 'build_only' field."""
        config = RunConfig.from_cli(build=True)
        assert config.build_only is True

    def test_full_cli_args(self) -> None:
        """All CLI arguments are correctly mapped."""
        config = RunConfig.from_cli(
            stack="java",
            build=True,
            path="/my/project",
            bare=True,
            debug_logs=True,
            deps_mode="prod",
            debug=1,
            prompt="hello",
            model="sonnet",
            quiet=True,
            append_system_prompt="extra",
            yes=True,
            no_prune=True,
            no_inhibit_sleep=True,
            unrestricted=True,
        )
        assert config.stack_name == "java"
        assert config.build_only is True
        assert config.path == "/my/project"
        assert config.bare is True
        assert config.debug_logs is True
        assert config.deps_mode == "prod"
        assert config.debug == 1
        assert config.prompt == "hello"
        assert config.model == "sonnet"
        assert config.quiet is True
        assert config.append_system_prompt == "extra"
        assert config.unattended is True
        assert config.prune is False
        assert config.inhibit_sleep is False
        assert config.unrestricted is True


class TestRunConfigEquality:
    """Tests for RunConfig equality."""

    def test_equal_configs(self) -> None:
        """Two configs with same values are equal."""
        config1 = RunConfig(stack_name="base", debug=1)
        config2 = RunConfig(stack_name="base", debug=1)
        assert config1 == config2

    def test_different_configs(self) -> None:
        """Two configs with different values are not equal."""
        config1 = RunConfig(stack_name="base")
        config2 = RunConfig(stack_name="go")
        assert config1 != config2
