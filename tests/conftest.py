"""Pytest configuration and fixtures for ccbox tests.

This module ensures the ccbox package is importable during tests
without requiring installation.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Add src directory to path for development testing
src_path = Path(__file__).parent.parent / "src"
if str(src_path) not in sys.path:
    sys.path.insert(0, str(src_path))
