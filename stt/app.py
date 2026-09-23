"""Loopback-only PCM transcription service. No Discord identifiers are accepted."""

from __future__ import annotations

import os
import gc
import logging
import time
import threading
from typing import Any

import numpy as np
from fastapi import FastAPI, Header, HTTPException, Request
from faster_whisper import WhisperModel


MODEL_NAME = os.getenv("STT_MODEL", "turbo")
COMPUTE_TYPE = os.getenv("STT_COMPUTE_TYPE", "int8_float16")
INITIAL_PROMPT = os.getenv(
    "STT_INITIAL_PROMPT", "VRChat、VRCosme、ぶいなび、Pulsoid、OSC、Poiyomi、lilToon"
)
MAX_AUDIO_BYTES = 28 * 16000 * 2
IDLE_UNLOAD_SECONDS = int(os.getenv("STT_IDLE_UNLOAD_SECONDS", "300"))

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
    return {"ready": _model is not None, "modelLoaded": _model is not None, "model": "large-v3-turbo"}


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
            segments, info = _model.transcribe(
                samples, language="ja", beam_size=1, initial_prompt=INITIAL_PROMPT,
                vad_filter=False, condition_on_previous_text=False, task="transcribe"
            )
            text = "".join(segment.text for segment in segments).strip()
        except Exception as exc:
            logging.exception("STT_TRANSCRIPTION_FAILED")
            raise HTTPException(503, "transcription_failed") from exc
    return {
        "text": text,
        "language": info.language,
        "languageProbability": float(info.language_probability),
        "durationMs": round(len(samples) / 16),
    }
