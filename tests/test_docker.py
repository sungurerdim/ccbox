"""Tests for docker module.

Tests all Docker operations with mocked subprocess calls.
"""

from __future__ import annotations

import subprocess
from unittest.mock import MagicMock, patch

import pytest

from ccbox.docker import (
    DockerError,
    DockerNotFoundError,
    DockerTimeoutError,
    check_docker_status,
    get_dangling_image_ids,
    get_image_ids,
    image_has_parent,
    list_containers,
    list_images,
    remove_container,
    remove_image,
    safe_docker_run,
)


class TestSafeDockerRun:
    """Tests for safe_docker_run function."""

    def test_success(self) -> None:
        """Test successful command execution."""
        with patch("ccbox.docker.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0,
                stdout="output",
                stderr="",
            )
            result = safe_docker_run(["docker", "info"])
            assert result.returncode == 0
            assert result.stdout == "output"
            mock_run.assert_called_once()

    def test_docker_not_found(self) -> None:
        """Test FileNotFoundError raises DockerNotFoundError."""
        with patch("ccbox.docker.subprocess.run") as mock_run:
            mock_run.side_effect = FileNotFoundError("docker not found")
            with pytest.raises(DockerNotFoundError) as exc_info:
                safe_docker_run(["docker", "info"])
            assert "Docker not found in PATH" in str(exc_info.value)

    def test_timeout(self) -> None:
        """Test TimeoutExpired raises DockerTimeoutError."""
        with patch("ccbox.docker.subprocess.run") as mock_run:
            mock_run.side_effect = subprocess.TimeoutExpired(cmd="docker", timeout=30)
            with pytest.raises(DockerTimeoutError) as exc_info:
                safe_docker_run(["docker", "info"], timeout=30)
            assert "timed out after 30s" in str(exc_info.value)

    def test_called_process_error_with_check(self) -> None:
        """Test CalledProcessError is raised when check=True."""
        with patch("ccbox.docker.subprocess.run") as mock_run:
            mock_run.side_effect = subprocess.CalledProcessError(
                returncode=1, cmd=["docker", "info"]
            )
            with pytest.raises(subprocess.CalledProcessError):
                safe_docker_run(["docker", "info"], check=True)

    def test_custom_timeout(self) -> None:
        """Test custom timeout is passed to subprocess."""
        with patch("ccbox.docker.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0)
            safe_docker_run(["docker", "info"], timeout=60)
            mock_run.assert_called_once()
            call_kwargs = mock_run.call_args.kwargs
            assert call_kwargs["timeout"] == 60

    def test_capture_output_false(self) -> None:
        """Test capture_output=False is passed to subprocess."""
        with patch("ccbox.docker.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0)
            safe_docker_run(["docker", "info"], capture_output=False)
            call_kwargs = mock_run.call_args.kwargs
            assert call_kwargs["capture_output"] is False


class TestCheckDockerStatus:
    """Tests for check_docker_status function."""

    def test_docker_running(self) -> None:
        """Test returns True when Docker is running."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0)
            assert check_docker_status() is True

    def test_docker_not_running(self) -> None:
        """Test returns False when Docker command fails."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1)
            assert check_docker_status() is False

    def test_docker_not_found(self) -> None:
        """Test returns False when Docker is not installed."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.side_effect = DockerNotFoundError("not found")
            assert check_docker_status() is False

    def test_docker_timeout(self) -> None:
        """Test returns False when Docker check times out."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.side_effect = DockerTimeoutError("timeout")
            assert check_docker_status() is False


class TestGetImageIds:
    """Tests for get_image_ids function."""

    def test_get_image_ids_success(self) -> None:
        """Test successful image ID retrieval."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0,
                stdout="abc123\ndef456\n",
            )
            result = get_image_ids("ccbox")
            assert result == {"abc123", "def456"}

    def test_get_image_ids_empty(self) -> None:
        """Test returns empty set when no images found."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0,
                stdout="\n",
            )
            result = get_image_ids("nonexistent")
            assert result == set()

    def test_get_image_ids_command_fails(self) -> None:
        """Test returns empty set when command fails."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1)
            result = get_image_ids("ccbox")
            assert result == set()

    def test_get_image_ids_docker_not_found(self) -> None:
        """Test returns empty set when Docker not found."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.side_effect = DockerNotFoundError("not found")
            result = get_image_ids("ccbox")
            assert result == set()

    def test_get_image_ids_timeout(self) -> None:
        """Test returns empty set on timeout."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.side_effect = DockerTimeoutError("timeout")
            result = get_image_ids("ccbox")
            assert result == set()


class TestGetDanglingImageIds:
    """Tests for get_dangling_image_ids function."""

    def test_get_dangling_success(self) -> None:
        """Test successful dangling image retrieval."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0,
                stdout="abc123\ndef456\n",
            )
            result = get_dangling_image_ids()
            assert result == ["abc123", "def456"]

    def test_get_dangling_empty(self) -> None:
        """Test returns empty list when no dangling images."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0,
                stdout="",
            )
            result = get_dangling_image_ids()
            assert result == []

    def test_get_dangling_command_fails(self) -> None:
        """Test returns empty list when command fails."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1)
            result = get_dangling_image_ids()
            assert result == []

    def test_get_dangling_docker_not_found(self) -> None:
        """Test returns empty list when Docker not found."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.side_effect = DockerNotFoundError("not found")
            result = get_dangling_image_ids()
            assert result == []


class TestImageHasParent:
    """Tests for image_has_parent function."""

    def test_has_parent(self) -> None:
        """Test returns True when image has matching parent."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0,
                stdout="parent123\nbase456\n",
            )
            result = image_has_parent("img123", {"parent123"})
            assert result is True

    def test_no_parent(self) -> None:
        """Test returns False when no matching parent."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0,
                stdout="other123\nunrelated456\n",
            )
            result = image_has_parent("img123", {"parent123"})
            assert result is False

    def test_command_fails(self) -> None:
        """Test returns False when history command fails."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1)
            result = image_has_parent("img123", {"parent123"})
            assert result is False

    def test_docker_not_found(self) -> None:
        """Test returns False when Docker not found."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.side_effect = DockerNotFoundError("not found")
            result = image_has_parent("img123", {"parent123"})
            assert result is False


class TestRemoveImage:
    """Tests for remove_image function."""

    def test_remove_success(self) -> None:
        """Test successful image removal."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0)
            result = remove_image("abc123")
            assert result is True
            mock_run.assert_called_once()
            # Verify -f flag is included
            call_args = mock_run.call_args[0][0]
            assert "-f" in call_args

    def test_remove_without_force(self) -> None:
        """Test removal without force flag."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0)
            result = remove_image("abc123", force=False)
            assert result is True
            call_args = mock_run.call_args[0][0]
            assert "-f" not in call_args

    def test_remove_fails(self) -> None:
        """Test returns False when removal fails."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1)
            result = remove_image("abc123")
            assert result is False

    def test_remove_docker_not_found(self) -> None:
        """Test returns False when Docker not found."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.side_effect = DockerNotFoundError("not found")
            result = remove_image("abc123")
            assert result is False


class TestRemoveContainer:
    """Tests for remove_container function."""

    def test_remove_success(self) -> None:
        """Test successful container removal."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0)
            result = remove_container("ccbox-test")
            assert result is True
            mock_run.assert_called_once()
            call_args = mock_run.call_args[0][0]
            assert "-f" in call_args

    def test_remove_without_force(self) -> None:
        """Test removal without force flag."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.return_value = MagicMock(returncode=0)
            result = remove_container("ccbox-test", force=False)
            assert result is True
            call_args = mock_run.call_args[0][0]
            assert "-f" not in call_args

    def test_remove_fails(self) -> None:
        """Test returns False when removal fails."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1)
            result = remove_container("ccbox-test")
            assert result is False

    def test_remove_docker_not_found(self) -> None:
        """Test returns False when Docker not found."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.side_effect = DockerNotFoundError("not found")
            result = remove_container("ccbox-test")
            assert result is False


class TestListContainers:
    """Tests for list_containers function."""

    def test_list_all(self) -> None:
        """Test listing all containers."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0,
                stdout="ccbox-project1\nccbox-project2\n",
            )
            result = list_containers()
            assert result == ["ccbox-project1", "ccbox-project2"]

    def test_list_with_name_filter(self) -> None:
        """Test listing with name filter."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0,
                stdout="ccbox-test\n",
            )
            result = list_containers(name_filter="ccbox-test")
            assert result == ["ccbox-test"]
            call_args = mock_run.call_args[0][0]
            assert "--filter" in call_args
            assert "name=ccbox-test" in call_args

    def test_list_with_status_filter(self) -> None:
        """Test listing with status filter."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0,
                stdout="ccbox-running\n",
            )
            result = list_containers(status_filter="running")
            assert result == ["ccbox-running"]
            call_args = mock_run.call_args[0][0]
            assert "status=running" in call_args

    def test_list_only_running(self) -> None:
        """Test listing only running containers."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0,
                stdout="ccbox-running\n",
            )
            result = list_containers(all_containers=False)
            assert result == ["ccbox-running"]
            call_args = mock_run.call_args[0][0]
            assert "-a" not in call_args

    def test_list_empty(self) -> None:
        """Test returns empty list when no containers."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0,
                stdout="\n",
            )
            result = list_containers()
            assert result == []

    def test_list_command_fails(self) -> None:
        """Test returns empty list when command fails."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1)
            result = list_containers()
            assert result == []

    def test_list_docker_not_found(self) -> None:
        """Test returns empty list when Docker not found."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.side_effect = DockerNotFoundError("not found")
            result = list_containers()
            assert result == []


class TestListImages:
    """Tests for list_images function."""

    def test_list_all(self) -> None:
        """Test listing all images."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0,
                stdout="ccbox:latest\nubuntu:22.04\n",
            )
            result = list_images()
            assert result == ["ccbox:latest", "ubuntu:22.04"]

    def test_list_with_prefix(self) -> None:
        """Test listing with prefix filter."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0,
                stdout="ccbox:latest\nccbox:dev\nubuntu:22.04\n",
            )
            result = list_images(prefix="ccbox")
            assert result == ["ccbox:latest", "ccbox:dev"]

    def test_list_empty(self) -> None:
        """Test returns empty list when no images."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0,
                stdout="\n",
            )
            result = list_images()
            assert result == []

    def test_list_command_fails(self) -> None:
        """Test returns empty list when command fails."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1)
            result = list_images()
            assert result == []

    def test_list_docker_not_found(self) -> None:
        """Test returns empty list when Docker not found."""
        with patch("ccbox.docker.safe_docker_run") as mock_run:
            mock_run.side_effect = DockerNotFoundError("not found")
            result = list_images()
            assert result == []


class TestDockerExceptions:
    """Tests for Docker exception hierarchy."""

    def test_docker_error_is_exception(self) -> None:
        """Test DockerError inherits from Exception."""
        assert issubclass(DockerError, Exception)

    def test_timeout_is_docker_error(self) -> None:
        """Test DockerTimeoutError inherits from DockerError."""
        assert issubclass(DockerTimeoutError, DockerError)

    def test_not_found_is_docker_error(self) -> None:
        """Test DockerNotFoundError inherits from DockerError."""
        assert issubclass(DockerNotFoundError, DockerError)

    def test_exception_messages(self) -> None:
        """Test exception messages are informative."""
        err = DockerNotFoundError("Docker not found in PATH")
        assert "Docker not found" in str(err)

        err = DockerTimeoutError("Command timed out after 30s")
        assert "timed out" in str(err)
