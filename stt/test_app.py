"""GPU-free checks for model leasing and silence rejection."""

import time
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

import app
from asr_quality import cer, classify_quality, signal_metrics, wer


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
        return [SimpleNamespace(
            text=" 音声テスト", start=0.0, end=1.0, avg_logprob=-0.2,
            no_speech_prob=0.01, compression_ratio=1.1,
        )], SimpleNamespace(
            language="ja", language_probability=1.0
        )


class SilenceFilterTests(unittest.TestCase):
    def test_no_speech_never_reaches_whisper(self):
        model = FakeModel()
        samples = np.zeros(16000, dtype=np.float32)
        with patch.object(app, "_model", model), patch.object(
            app, "get_speech_timestamps", return_value=[]
        ):
            result = app._transcribe_samples(samples)
            self.assertEqual(result["text"], "")
            self.assertEqual(result["asr"]["speechDurationMs"], 0)
        self.assertIsNone(model.received)

    def test_only_detected_speech_reaches_whisper(self):
        model = FakeModel()
        samples = np.arange(16000, dtype=np.float32)
        with patch.object(app, "_model", model), patch.object(
            app, "get_speech_timestamps", return_value=[{"start": 2000, "end": 6000}]
        ):
            result = app._transcribe_samples(samples)
            self.assertEqual(result["text"], "音声テスト")
            self.assertEqual(result["language"], "ja")
            self.assertEqual(result["asr"]["avgLogprob"], -0.2)
        np.testing.assert_array_equal(model.received, samples[2000:6000])
        self.assertIsNone(model.options["initial_prompt"])
        self.assertEqual(model.options["temperature"], 0.0)
        self.assertFalse(model.options["condition_on_previous_text"])
        self.assertFalse(model.options["vad_filter"])

    def test_quieter_voice_vad_configuration_is_used(self):
        self.assertEqual(app.VAD_OPTIONS.threshold, 0.35)
        self.assertEqual(app.VAD_OPTIONS.min_speech_duration_ms, 100)
        self.assertEqual(app.VAD_OPTIONS.speech_pad_ms, 250)

    def test_debug_audio_is_off_by_default_and_bounded_when_enabled(self):
        model = FakeModel()
        samples = np.ones(16000, dtype=np.float32) * 0.01
        with tempfile.TemporaryDirectory() as directory, patch.object(app, "_model", model), patch.object(
            app, "get_speech_timestamps", return_value=[{"start": 0, "end": 16000}]
        ), patch.object(app, "DEBUG_AUDIO", True), patch.object(
            app, "DEBUG_AUDIO_DIR", Path(directory)
        ), patch.object(app, "DEBUG_AUDIO_MAX_FILES", 2):
            app._transcribe_samples(samples, "debug-test")
            files = sorted(Path(directory).glob("*.wav"))
            self.assertEqual(len(files), 2)
            self.assertTrue(all(path.stat().st_size > 44 for path in files))


class AsrQualityTests(unittest.TestCase):
    def test_hallucination_phrase_requires_additional_evidence_and_text_is_unchanged(self):
        reliable = classify_quality(
            "ありがとうございました", avg_logprob=-0.2, no_speech_prob=0.01,
            compression_ratio=1.1, rms_dbfs=-20, speech_duration_ms=1200,
        )
        suspicious = classify_quality(
            "ご視聴ありがとうございました", avg_logprob=-1.1, no_speech_prob=0.8,
            compression_ratio=1.1, rms_dbfs=-50, speech_duration_ms=300,
        )
        self.assertFalse(reliable["suspectedHallucination"])
        self.assertTrue(suspicious["suspectedHallucination"])
        self.assertIn("known_hallucination_phrase", suspicious["hallucinationReasons"])

    def test_signal_and_error_metrics_are_reproducible(self):
        metrics = signal_metrics(np.array([0.0, 0.5, -0.5], dtype=np.float32))
        self.assertAlmostEqual(metrics["peak"], 0.5)
        self.assertEqual(cer("ＧＡ４です。", "GA4です"), 0.0)
        self.assertEqual(wer("Search Console", "Search Console"), 0.0)


if __name__ == "__main__":
    unittest.main()
