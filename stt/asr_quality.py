"""Deterministic ASR quality metrics. This module never rewrites transcript text."""

from __future__ import annotations

import math
import re
import unicodedata
from typing import Any

import numpy as np


HALLUCINATION_PHRASES = {
    "ご視聴ありがとうございました",
    "最後までご視聴ありがとうございました",
    "ありがとうございました",
    "お待ちしております",
    "バイバイ",
    "それではまた",
    "またお会いしましょう",
    "この動画でお会いしましょう",
}


def normalize_phrase(text: str) -> str:
    return re.sub(r"[\s。．.!！?？、，]+", "", unicodedata.normalize("NFKC", text))


def signal_metrics(samples: np.ndarray) -> dict[str, float]:
    if samples.size == 0:
        return {"rmsDbfs": -120.0, "peak": 0.0, "clippingRatio": 0.0}
    absolute = np.abs(samples.astype(np.float64, copy=False))
    rms = float(np.sqrt(np.mean(np.square(absolute))))
    return {
        "rmsDbfs": round(20 * math.log10(max(rms, 1e-6)), 2),
        "peak": round(float(np.max(absolute)), 6),
        "clippingRatio": round(float(np.mean(absolute >= 0.999)), 8),
    }


def classify_quality(
    text: str,
    *,
    avg_logprob: float | None,
    no_speech_prob: float | None,
    compression_ratio: float | None,
    rms_dbfs: float,
    speech_duration_ms: int,
) -> dict[str, Any]:
    phrase_match = normalize_phrase(text) in {
        normalize_phrase(phrase) for phrase in HALLUCINATION_PHRASES
    }
    evidence: list[str] = []
    if rms_dbfs <= -42.0:
        evidence.append("very_low_rms")
    if speech_duration_ms <= 600:
        evidence.append("short_speech")
    if no_speech_prob is not None and no_speech_prob >= 0.55:
        evidence.append("high_no_speech_probability")
    if avg_logprob is not None and avg_logprob <= -0.85:
        evidence.append("low_average_log_probability")
    if compression_ratio is not None and compression_ratio >= 2.4:
        evidence.append("high_compression_ratio")

    # A common phrase alone is not enough: actual meeting participants may say it.
    # Require acoustic/model evidence, or three independent warning signals for
    # text outside the known phrase set. The Node queue adds repetition evidence.
    suspected = (phrase_match and len(evidence) >= 1) or len(evidence) >= 3
    if suspected and phrase_match:
        evidence.insert(0, "known_hallucination_phrase")

    if not text:
        confidence = "none"
    elif suspected or (avg_logprob is not None and avg_logprob <= -1.0):
        confidence = "low"
    elif ((avg_logprob is None or avg_logprob < -0.5)
          or (no_speech_prob is not None and no_speech_prob >= 0.3)):
        confidence = "medium"
    else:
        confidence = "high"
    return {
        "confidence": confidence,
        "suspectedHallucination": suspected,
        "hallucinationReasons": evidence,
        "hallucinationPhraseMatch": phrase_match,
    }


def _distance(left: list[str] | str, right: list[str] | str) -> int:
    previous = list(range(len(right) + 1))
    for row, lhs in enumerate(left, start=1):
        current = [row]
        for column, rhs in enumerate(right, start=1):
            current.append(min(
                current[-1] + 1,
                previous[column] + 1,
                previous[column - 1] + (lhs != rhs),
            ))
        previous = current
    return previous[-1]


def normalize_for_cer(text: str) -> str:
    value = unicodedata.normalize("NFKC", text).lower()
    return "".join(char for char in value if not char.isspace() and not unicodedata.category(char).startswith("P"))


def cer(reference: str, hypothesis: str) -> float:
    normalized = normalize_for_cer(reference)
    if not normalized:
        return 0.0 if not normalize_for_cer(hypothesis) else 1.0
    return _distance(normalized, normalize_for_cer(hypothesis)) / len(normalized)


def wer(reference: str, hypothesis: str) -> float:
    expected = unicodedata.normalize("NFKC", reference).lower().split()
    actual = unicodedata.normalize("NFKC", hypothesis).lower().split()
    if not expected:
        return 0.0 if not actual else 1.0
    return _distance(expected, actual) / len(expected)
