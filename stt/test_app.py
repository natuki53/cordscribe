"""GPU-free checks for model leasing and silence rejection."""

import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

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


class FakeModel:
    def __init__(self):
        self.received = None
        self.options = None

    def transcribe(self, audio, **kwargs):
        self.received = audio
        self.options = kwargs
        return [SimpleNamespace(text=" 音声テスト")], SimpleNamespace(
            language="ja", language_probability=1.0
        )


class SilenceFilterTests(unittest.TestCase):
    def test_no_speech_never_reaches_whisper(self):
        model = FakeModel()
        samples = np.zeros(16000, dtype=np.float32)
        with patch.object(app, "_model", model), patch.object(
            app, "get_speech_timestamps", return_value=[]
        ):
            self.assertEqual(app._transcribe_samples(samples), ("", "ja", 0.0))
        self.assertIsNone(model.received)

    def test_only_detected_speech_reaches_whisper(self):
        model = FakeModel()
        samples = np.arange(16000, dtype=np.float32)
        with patch.object(app, "_model", model), patch.object(
            app, "get_speech_timestamps", return_value=[{"start": 2000, "end": 6000}]
        ):
            self.assertEqual(app._transcribe_samples(samples), ("音声テスト", "ja", 1.0))
        np.testing.assert_array_equal(model.received, samples[2000:6000])
        self.assertIsNone(model.options["initial_prompt"])


if __name__ == "__main__":
    unittest.main()
