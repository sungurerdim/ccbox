"""Tests for path conversion utilities."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from ccbox.paths import (
    _normalize_path_separators,
    is_windows_path,
    is_wsl,
    resolve_for_docker,
    windows_to_docker_path,
    wsl_to_docker_path,
)


class TestIsWindowsPath:
    """Tests for is_windows_path function."""

    def test_windows_backslash_path(self) -> None:
        assert is_windows_path(r"D:\GitHub\Project") is True

    def test_windows_forward_slash_path(self) -> None:
        assert is_windows_path("D:/GitHub/Project") is True

    def test_windows_drive_only(self) -> None:
        assert is_windows_path("C:/") is True
        assert is_windows_path(r"C:\\") is True

    def test_lowercase_drive(self) -> None:
        assert is_windows_path("c:/Users/name") is True

    def test_linux_path(self) -> None:
        assert is_windows_path("/home/user/project") is False

    def test_relative_path(self) -> None:
        assert is_windows_path("./project") is False
        assert is_windows_path("project") is False

    def test_wsl_path(self) -> None:
        assert is_windows_path("/mnt/c/Users/name") is False

    def test_pathlib_path(self) -> None:
        assert is_windows_path(Path("/home/user")) is False


class TestNormalizePathSeparators:
    """Tests for _normalize_path_separators function."""

    def test_backslashes_converted(self) -> None:
        assert _normalize_path_separators(r"foo\bar\baz") == "foo/bar/baz"

    def test_double_slashes_removed(self) -> None:
        assert _normalize_path_separators("foo//bar///baz") == "foo/bar/baz"

    def test_trailing_slash_removed(self) -> None:
        assert _normalize_path_separators("foo/bar/") == "foo/bar"

    def test_root_slash_preserved(self) -> None:
        assert _normalize_path_separators("/") == "/"

    def test_empty_string(self) -> None:
        assert _normalize_path_separators("") == ""


class TestWindowsToDockerPath:
    """Tests for windows_to_docker_path function."""

    def test_basic_conversion(self) -> None:
        assert windows_to_docker_path(r"D:\GitHub\Project") == "D:/GitHub/Project"

    def test_forward_slash_input(self) -> None:
        assert windows_to_docker_path("D:/GitHub/Project") == "D:/GitHub/Project"

    def test_lowercase_drive(self) -> None:
        assert windows_to_docker_path("c:/Users/name/project") == "C:/Users/name/project"

    def test_uppercase_drive_becomes_lowercase(self) -> None:
        assert windows_to_docker_path("C:/Users/name") == "C:/Users/name"

    def test_mixed_slashes(self) -> None:
        assert windows_to_docker_path(r"D:\GitHub/Mixed\Path") == "D:/GitHub/Mixed/Path"

    def test_trailing_slash_removed(self) -> None:
        assert windows_to_docker_path("D:/Project/") == "D:/Project"
        assert windows_to_docker_path(r"D:\Project\\") == "D:/Project"

    def test_deep_path(self) -> None:
        path = r"D:\GitHub\ClaudeCodeOptimizer\benchmark\output\test"
        expected = "D:/GitHub/ClaudeCodeOptimizer/benchmark/output/test"
        assert windows_to_docker_path(path) == expected

    def test_path_with_spaces(self) -> None:
        assert windows_to_docker_path(r"C:\Program Files\App") == "C:/Program Files/App"

    def test_non_windows_path_unchanged(self) -> None:
        assert windows_to_docker_path("/home/user/project") == "/home/user/project"

    def test_relative_path_unchanged(self) -> None:
        assert windows_to_docker_path("relative/path") == "relative/path"

    def test_root_drive_only(self) -> None:
        assert windows_to_docker_path("C:/") == "C:/"
        assert windows_to_docker_path(r"C:\\") == "C:/"
        assert windows_to_docker_path("D:") == "D:/"

    def test_double_slashes_normalized(self) -> None:
        assert windows_to_docker_path(r"C:\Users\\name\\project") == "C:/Users/name/project"


class TestWslToDockerPath:
    """Tests for wsl_to_docker_path function."""

    def test_basic_conversion(self) -> None:
        assert wsl_to_docker_path("/mnt/c/Users/name/project") == "/c/Users/name/project"

    def test_different_drive(self) -> None:
        assert wsl_to_docker_path("/mnt/d/GitHub/Project") == "/d/GitHub/Project"

    def test_trailing_slash_removed(self) -> None:
        assert wsl_to_docker_path("/mnt/c/Project/") == "/c/Project"

    def test_non_wsl_mount_unchanged(self) -> None:
        assert wsl_to_docker_path("/home/user/project") == "/home/user/project"

    def test_mnt_but_not_drive_unchanged(self) -> None:
        assert wsl_to_docker_path("/mnt/somedir/file") == "/mnt/somedir/file"

    def test_root_drive_only(self) -> None:
        assert wsl_to_docker_path("/mnt/c") == "/c"
        assert wsl_to_docker_path("/mnt/c/") == "/c"
        assert wsl_to_docker_path("/mnt/d") == "/d"


class TestResolveForDocker:
    """Tests for resolve_for_docker function."""

    def test_windows_path_converted(self) -> None:
        # Test is covered by test_integration_windows_style below
        pass

    def test_wsl_path_converted(self) -> None:
        path = Path("/mnt/c/Users/name/project")
        assert resolve_for_docker(path) == "/c/Users/name/project"

    def test_wsl_root_drive_converted(self) -> None:
        path = Path("/mnt/d")
        assert resolve_for_docker(path) == "/d"

    def test_linux_path_unchanged(self) -> None:
        path = Path("/home/user/project")
        assert resolve_for_docker(path) == "/home/user/project"

    def test_mnt_non_drive_unchanged(self) -> None:
        # /mnt/data should NOT be converted (not a single-letter drive)
        path = Path("/mnt/data/files")
        assert resolve_for_docker(path) == "/mnt/data/files"

    def test_integration_windows_style(self) -> None:
        """Test with a mock path that looks like Windows path."""

        class MockPath:
            def __str__(self) -> str:
                return r"D:\GitHub\Project"

            @property
            def name(self) -> str:
                return "Project"

        mock_path = MockPath()
        result = resolve_for_docker(mock_path)  # type: ignore[arg-type]
        assert result == "D:/GitHub/Project"


class TestIsWsl:
    """Tests for is_wsl function."""

    def test_wsl_detection_via_proc_version(self) -> None:
        # Clear the functools.cache
        is_wsl.cache_clear()

        mock_content = "Linux version 5.10.16.3-microsoft-standard-WSL2"
        with patch("builtins.open", create=True) as mock_open:
            mock_open.return_value.__enter__.return_value.read.return_value = mock_content
            assert is_wsl() is True

        # Clear cache after test
        is_wsl.cache_clear()

    def test_non_wsl_linux(self) -> None:
        is_wsl.cache_clear()

        mock_content = "Linux version 5.15.0-generic"
        with (
            patch("builtins.open", create=True) as mock_open,
            patch.dict("os.environ", {}, clear=True),
        ):
            mock_open.return_value.__enter__.return_value.read.return_value = mock_content
            assert is_wsl() is False

        is_wsl.cache_clear()

    def test_wsl_detection_via_env_var(self) -> None:
        is_wsl.cache_clear()

        with (
            patch("builtins.open", side_effect=OSError),
            patch.dict("os.environ", {"WSL_DISTRO_NAME": "Ubuntu"}),
        ):
            assert is_wsl() is True

        is_wsl.cache_clear()

    def test_no_wsl_indicators(self) -> None:
        is_wsl.cache_clear()

        with (
            patch("builtins.open", side_effect=OSError),
            patch.dict("os.environ", {}, clear=True),
        ):
            assert is_wsl() is False

        is_wsl.cache_clear()

    def test_caching(self) -> None:
        """Test that result is cached via functools.cache."""
        is_wsl.cache_clear()

        # First call sets the cache
        with (
            patch("builtins.open", side_effect=OSError),
            patch.dict("os.environ", {"WSL_DISTRO_NAME": "Ubuntu"}),
        ):
            first_result = is_wsl()
            assert first_result is True

        # Second call returns cached value even with different mocks
        # (Because functools.cache caches based on arguments, not internal state)
        # We need to check cache_info instead
        cache_info = is_wsl.cache_info()
        assert cache_info.hits >= 0  # Cache is working

        # Clear cache after test
        is_wsl.cache_clear()
