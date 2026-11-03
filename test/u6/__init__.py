"""Tests for the Hermes adapter (hosts/hermes). The repository root goes on sys.path so `hosts.hermes` imports the
same way whichever directory discovery runs from."""

import sys
from pathlib import Path

_REPO = str(Path(__file__).resolve().parents[2])
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)
