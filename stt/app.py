"""Loopback-only PCM transcription service. No Discord identifiers are accepted."""

from __future__ import annotations

import os
import gc
import json
import logging
from pathlib import Path
import time
import threading
import uuid
import wave
from typing import Any

import numpy as np
from fastapi import FastAPI, Header, HTTPException, Request
from faster_whisper import WhisperModel
from faster_whisper.vad import VadOptions, collect_chunks, get_speech_timestamps

from asr_quality import classify_quality, signal_metrics


MODEL_NAME = os.getenv("STT_MODEL", "turbo")
COMPUTE_TYPE = os.getenv("STT_COMPUTE_TYPE", "int8_float16")
BEAM_SIZE = int(os.getenv("STT_BEAM_SIZE", "1"))
BEST_OF = int(os.getenv("STT_BEST_OF", "1"))
TEMPERATURE = float(os.getenv("STT_TEMPERATURE", "0"))
NO_SPEECH_THRESHOLD = float(os.getenv("STT_NO_SPEECH_THRESHOLD", "0.6"))
LOG_PROB_THRESHOLD = float(os.getenv("STT_LOG_PROB_THRESHOLD", "-1.0"))
COMPRESSION_RATIO_THRESHOLD = float(os.getenv("STT_COMPRESSION_RATIO_THRESHOLD", "2.4"))
REPETITION_PENALTY = float(os.getenv("STT_REPETITION_PENALTY", "1.0"))
NO_REPEAT_NGRAM_SIZE = int(os.getenv("STT_NO_REPEAT_NGRAM_SIZE", "0"))
CONDITION_ON_PREVIOUS_TEXT = os.getenv("STT_CONDITION_ON_PREVIOUS_TEXT", "false").lower() == "true"
# A vocabulary prompt can turn weak audio into plausible-looking invented text.
# Keep it opt-in even when an older environment file still defines the prompt.
INITIAL_PROMPT = (
    os.getenv("STT_INITIAL_PROMPT", "").strip() or None
) if os.getenv("STT_INITIAL_PROMPT_ENABLED", "false").lower() == "true" else None


def _load_hotwords() -> str | None:
    values: list[str] = []
    configured = os.getenv("STT_HOTWORDS", "").strip()
    if configured:
        values.append(configured)
    terms_file = os.getenv("STT_TERMS_FILE", "").strip()
    if terms_file:
        parsed = json.loads(Path(terms_file).read_text(encoding="utf-8"))
        if not isinstance(parsed, list) or any(not isinstance(item, str) for item in parsed):
            raise ValueError("STT_TERMS_FILE must contain a JSON string array")
        values.extend(item.strip() for item in parsed if item.strip())
    return "、".join(values) or None


HOTWORDS = _load_hotwords()
MAX_AUDIO_BYTES = 28 * 16000 * 2
IDLE_UNLOAD_SECONDS = int(os.getenv("STT_IDLE_UNLOAD_SECONDS", "300"))
DEBUG_AUDIO = os.getenv("TRANSCRIPTION_DEBUG_AUDIO", "false").lower() == "true"
DEBUG_AUDIO_DIR = Path(os.getenv("TRANSCRIPTION_DEBUG_AUDIO_DIR", "/tmp/cordscribe-asr-debug"))
DEBUG_AUDIO_MAX_FILES = max(2, int(os.getenv("TRANSCRIPTION_DEBUG_AUDIO_MAX_FILES", "100")))
DEBUG_LOG = os.getenv("TRANSCRIPTION_DEBUG_LOG", "false").lower() == "true"
VAD_OPTIONS = VadOptions(
    threshold=float(os.getenv("STT_VAD_THRESHOLD", "0.35")),
    min_speech_duration_ms=int(os.getenv("STT_VAD_MIN_SPEECH_MS", "100")),
    min_silence_duration_ms=int(os.getenv("STT_VAD_MIN_SILENCE_MS", "500")),
    speech_pad_ms=int(os.getenv("STT_VAD_SPEECH_PAD_MS", "250")),
)

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
_lock = threading.RLock()
_model: WhisperModel | None = None
_last_use = time.monotonic()


def _load() -> None:
    global _model, _last_use
    with _lock:
        if _model is None:
            _model = WhisperModel(MODEL_NAME, device="cuda", compute_type=COMPUTE_TYPE)
        _last_use = time.monotonic()


def _idle_unload_once() -> bool:
    global _model
    with _lock:
        if _model is None or time.monotonic() - _last_use < IDLE_UNLOAD_SECONDS:
            return False
        _model = None
        gc.collect()
        logging.info("STT_IDLE_UNLOADED")
        return True


def _idle_unload() -> None:
    while True:
        time.sleep(min(30, max(1, IDLE_UNLOAD_SECONDS / 2)))
        _idle_unload_once()


def _write_debug_wav(identifier: str, suffix: str, samples: np.ndarray) -> None:
    if not DEBUG_AUDIO:
        return
    try:
        DEBUG_AUDIO_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = DEBUG_AUDIO_DIR / f"{identifier}-{suffix}.wav"
        pcm = np.clip(samples, -1.0, 1.0)
        pcm = (pcm * 32767.0).astype("<i2").tobytes()
        with wave.open(str(path), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(16000)
            output.writeframes(pcm)
        path.chmod(0o600)
        files = sorted(DEBUG_AUDIO_DIR.glob("*.wav"), key=lambda item: item.stat().st_mtime)
        for stale in files[:-DEBUG_AUDIO_MAX_FILES]:
            stale.unlink(missing_ok=True)
    except Exception:
        logging.exception("STT_DEBUG_AUDIO_WRITE_FAILED")


def _aggregate_segments(segments: list[Any]) -> tuple[float | None, float | None, float | None]:
    if not segments:
        return None, None, None
    durations = [max(0.001, float(segment.end) - float(segment.start)) for segment in segments]
    total = sum(durations)
    avg_logprob = sum(float(segment.avg_logprob) * duration for segment, duration in zip(segments, durations)) / total
    no_speech_prob = max(float(segment.no_speech_prob) for segment in segments)
    compression_ratio = max(float(segment.compression_ratio) for segment in segments)
    return avg_logprob, no_speech_prob, compression_ratio


def _transcribe_samples(samples: np.ndarray, debug_identifier: str | None = None) -> dict[str, Any]:
    # RMS on the Bot only rejects quiet PCM. Voice activity detection here keeps
    # background noise from reaching Whisper, which may invent words on silence.
    audio = signal_metrics(samples)
    if debug_identifier:
        _write_debug_wav(debug_identifier, "input", samples)
    speech_chunks = get_speech_timestamps(samples, VAD_OPTIONS)
    if not speech_chunks:
        return {
            "text": "", "language": "ja", "languageProbability": 0.0,
            "asr": {
                **audio, "avgLogprob": None, "noSpeechProbability": None,
                "compressionRatio": None, "speechDurationMs": 0,
                "confidence": "none", "suspectedHallucination": False,
                "hallucinationReasons": [], "hallucinationPhraseMatch": False,
                "debugAudioId": debug_identifier if DEBUG_AUDIO else None,
            },
        }
    speech_audio = np.concatenate(collect_chunks(samples, speech_chunks)[0])
    speech_duration_ms = round(len(speech_audio) / 16)
    if debug_identifier:
        _write_debug_wav(debug_identifier, "speech", speech_audio)
    assert _model is not None
    inference_started = time.perf_counter()
    segments, info = _model.transcribe(
        speech_audio, language="ja", task="transcribe", beam_size=BEAM_SIZE,
        best_of=BEST_OF, temperature=TEMPERATURE,
        compression_ratio_threshold=COMPRESSION_RATIO_THRESHOLD,
        log_prob_threshold=LOG_PROB_THRESHOLD,
        no_speech_threshold=NO_SPEECH_THRESHOLD,
        condition_on_previous_text=CONDITION_ON_PREVIOUS_TEXT,
        initial_prompt=INITIAL_PROMPT, hotwords=HOTWORDS,
        repetition_penalty=REPETITION_PENALTY,
        no_repeat_ngram_size=NO_REPEAT_NGRAM_SIZE, vad_filter=False,
        word_timestamps=False,
    )
    materialized = list(segments)
    processing_ms = round((time.perf_counter() - inference_started) * 1000)
    text = "".join(segment.text for segment in materialized).strip()
    avg_logprob, no_speech_prob, compression_ratio = _aggregate_segments(materialized)
    quality = classify_quality(
        text, avg_logprob=avg_logprob, no_speech_prob=no_speech_prob,
        compression_ratio=compression_ratio, rms_dbfs=audio["rmsDbfs"],
        speech_duration_ms=speech_duration_ms,
    )
    asr = {
        **audio,
        "avgLogprob": avg_logprob,
        "noSpeechProbability": no_speech_prob,
        "compressionRatio": compression_ratio,
        "speechDurationMs": speech_duration_ms,
        **quality,
        "debugAudioId": debug_identifier if DEBUG_AUDIO else None,
    }
    if DEBUG_LOG:
        logging.info(
            "ASR_DEBUG id=%s model=%s compute_type=%s language=%s duration_ms=%d "
            "speech_ms=%d processing_ms=%d rms_dbfs=%.2f peak=%.4f "
            "clipping_ratio=%.6f avg_logprob=%s no_speech_prob=%s compression_ratio=%s "
            "confidence=%s suspected_hallucination=%s text_length=%d",
            debug_identifier, MODEL_NAME, COMPUTE_TYPE, info.language,
            round(len(samples) / 16), speech_duration_ms, processing_ms,
            audio["rmsDbfs"], audio["peak"], audio["clippingRatio"],
            avg_logprob, no_speech_prob, compression_ratio, quality["confidence"],
            quality["suspectedHallucination"], len(text),
        )
    return {
        "text": text, "language": info.language,
        "languageProbability": float(info.language_probability), "asr": asr,
    }


@app.on_event("startup")
def startup() -> None:
    try:
        _load()
    except Exception:
        # Keep the health endpoint alive; /ready stays false until VRAM is available.
        logging.exception("STT_MODEL_LOAD_FAILED")
    threading.Thread(target=_idle_unload, daemon=True, name="stt-idle-unload").start()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/ready")
def ready() -> dict[str, Any]:
    return {
        "ready": _model is not None, "modelLoaded": _model is not None,
        "model": MODEL_NAME, "computeType": COMPUTE_TYPE,
    }


@app.post("/admin/load")
def load() -> dict[str, bool]:
    try:
        _load()
    except Exception as exc:
        logging.exception("STT_MODEL_LOAD_FAILED")
        raise HTTPException(503, "model_load_failed") from exc
    return {"ready": True}


@app.post("/admin/unload")
def unload() -> dict[str, bool]:
    global _model
    with _lock:
        _model = None
        gc.collect()
    return {"ready": False}


@app.post("/admin/keepalive")
def keepalive() -> dict[str, bool]:
    global _last_use
    with _lock:
        if _model is None:
            raise HTTPException(503, "model_not_loaded")
        _last_use = time.monotonic()
    return {"ready": True}


@app.post("/v1/transcribe")
async def transcribe(
    request: Request,
    x_audio_format: str = Header(),
    x_sample_rate: int = Header(),
    x_channels: int = Header(),
    x_language: str = Header(),
) -> dict[str, Any]:
    if (x_audio_format, x_sample_rate, x_channels, x_language) != ("s16le", 16000, 1, "ja"):
        raise HTTPException(415, "unsupported_audio_format")
    data = await request.body()
    if not data or len(data) > MAX_AUDIO_BYTES or len(data) % 2:
        raise HTTPException(400, "invalid_audio")
    with _lock:
        if _model is None:
            raise HTTPException(503, "model_not_loaded")
        global _last_use
        _last_use = time.monotonic()
        try:
            samples = np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0
            result = _transcribe_samples(samples, uuid.uuid4().hex if (DEBUG_AUDIO or DEBUG_LOG) else None)
        except Exception as exc:
            logging.exception("STT_TRANSCRIPTION_FAILED")
            raise HTTPException(503, "transcription_failed") from exc
    return {
        **result,
        "durationMs": round(len(samples) / 16),
    }
