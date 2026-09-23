"""GPU-free checks for the model lease used by the shared Ollama host."""

import time
import unittest
from unittest.mock import patch

import app


class ModelLeaseTest(unittest.TestCase):
    def tearDown(self) -> None:
        app.unload()

    def test_keepalive_prevents_idle_unload(self) -> None:
        with patch.object(app, "WhisperModel", return_value=object()):
            app._load()
        app._last_use = time.monotonic() - app.IDLE_UNLOAD_SECONDS - 1
        self.assertTrue(app.keepalive()["ready"])
        self.assertFalse(app._idle_unload_once())
        self.assertTrue(app.ready()["ready"])

    def test_idle_model_is_released(self) -> None:
        with patch.object(app, "WhisperModel", return_value=object()):
            app._load()
        app._last_use = time.monotonic() - app.IDLE_UNLOAD_SECONDS - 1
        self.assertTrue(app._idle_unload_once())
        self.assertFalse(app.ready()["ready"])


if __name__ == "__main__":
    unittest.main()
