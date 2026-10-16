"""Deterministic ASR quality metrics. This module never rewrites transcript text."""

from __future__ import annotations

import math
import re
import unicodedata
import zlib
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


def text_repetition_ratio(text: str) -> float:
    """Return a whole-utterance compression signal for decoder repetition loops."""
    encoded = text.encode("utf-8")
    if not encoded:
        return 0.0
    return round(len(encoded) / max(1, len(zlib.compress(encoded))), 2)


def match_hallucination_phrase(text: str) -> str | None:
    normalized = normalize_phrase(text)
    # Longest-first prevents the generic thank-you phrase from masking the
    # more specific video-outro phrase. A suffix match catches hallucinations
    # appended to otherwise useful speech without rewriting that speech.
    for phrase in sorted(HALLUCINATION_PHRASES, key=len, reverse=True):
        if normalized.endswith(normalize_phrase(phrase)):
            return phrase
    return None


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
    matched_phrase = match_hallucination_phrase(text)
    repetition_ratio = text_repetition_ratio(text)
    strong_text_loop = len(normalize_phrase(text)) >= 40 and repetition_ratio >= 3.0
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
    if strong_text_loop:
        evidence.append("high_text_repetition_ratio")

    # A common phrase alone is not enough: actual meeting participants may say it.
    # Require acoustic/model evidence, or three independent warning signals for
    # text outside the known phrase set. The Node queue adds repetition evidence.
    suspected = strong_text_loop or (matched_phrase is not None and len(evidence) >= 1) or len(evidence) >= 3
    if suspected and matched_phrase is not None:
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
        "hallucinationPhraseMatch": matched_phrase is not None,
        "hallucinationPhrase": matched_phrase,
        "textRepetitionRatio": repetition_ratio,
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
