"""Reproducible Japanese ASR benchmark for local audio fixtures."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import time
from typing import Any

import numpy as np
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio
from faster_whisper.vad import VadOptions, collect_chunks, get_speech_timestamps

from asr_quality import cer, classify_quality, signal_metrics, wer


def gpu_memory_mib() -> int | None:
    try:
        output = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            text=True, timeout=5,
        )
        return sum(int(line.strip()) for line in output.splitlines() if line.strip())
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def aggregate(segments: list[Any]) -> tuple[float | None, float | None, float | None]:
    if not segments:
        return None, None, None
    durations = [max(0.001, float(item.end) - float(item.start)) for item in segments]
    total = sum(durations)
    return (
        sum(float(item.avg_logprob) * duration for item, duration in zip(segments, durations)) / total,
        max(float(item.no_speech_prob) for item in segments),
        max(float(item.compression_ratio) for item in segments),
    )


def parse_model(value: str) -> tuple[str, str, int]:
    parts = value.rsplit(":", 2)
    if len(parts) != 3 or not parts[2].isdigit():
        raise argparse.ArgumentTypeError("model must be MODEL:COMPUTE_TYPE:BEAM_SIZE")
    return parts[0], parts[1], int(parts[2])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--model", action="append", type=parse_model, required=True)
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--hotwords", help="Comma- or Japanese-comma-separated vocabulary hints; never rewrites output")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    samples = manifest.get("samples")
    if not isinstance(samples, list) or not samples:
        raise ValueError("manifest.samples must be a non-empty array")

    vad = VadOptions(threshold=0.35, min_speech_duration_ms=100,
                     min_silence_duration_ms=500, speech_pad_ms=250)
    results: list[dict[str, Any]] = []
    for model_name, compute_type, beam_size in args.model:
        before_vram = gpu_memory_mib()
        model = WhisperModel(model_name, device=args.device, compute_type=compute_type)
        loaded_vram = gpu_memory_mib()
        rows = []
        for sample in samples:
            path = (args.manifest.parent / sample["audio"]).resolve()
            reference = str(sample.get("reference", ""))
            audio = decode_audio(str(path), sampling_rate=16000)
            duration_seconds = len(audio) / 16000
            metrics = signal_metrics(audio)
            chunks = get_speech_timestamps(audio, vad)
            speech = np.concatenate(collect_chunks(audio, chunks)[0]) if chunks else np.empty(0, dtype=np.float32)
            started = time.perf_counter()
            if speech.size:
                generated, _ = model.transcribe(
                    speech, language="ja", task="transcribe", beam_size=beam_size,
                    best_of=1, temperature=0.0, no_speech_threshold=0.6,
                    log_prob_threshold=-1.0, compression_ratio_threshold=2.4,
                    repetition_penalty=1.0, no_repeat_ngram_size=0,
                    condition_on_previous_text=False, vad_filter=False,
                    initial_prompt=None, hotwords=args.hotwords,
                )
                segments = list(generated)
            else:
                segments = []
            latency = time.perf_counter() - started
            hypothesis = "".join(item.text for item in segments).strip()
            avg_logprob, no_speech_prob, compression_ratio = aggregate(segments)
            quality = classify_quality(
                hypothesis, avg_logprob=avg_logprob, no_speech_prob=no_speech_prob,
                compression_ratio=compression_ratio, rms_dbfs=metrics["rmsDbfs"],
                speech_duration_ms=round(len(speech) / 16),
            )
            rows.append({
                "id": sample.get("id", path.stem), "audio": str(path),
                "kind": sample.get("kind", "speech"), "reference": reference,
                "hypothesis": hypothesis, "cer": cer(reference, hypothesis),
                "wer": wer(reference, hypothesis), "latencySeconds": round(latency, 4),
                "realTimeFactor": round(latency / max(duration_seconds, 0.001), 4),
                "audioDurationSeconds": round(duration_seconds, 4), **metrics, **quality,
            })
        speech_rows = [row for row in rows if row["reference"]]
        non_speech_rows = [row for row in rows if not row["reference"]]
        results.append({
            "model": model_name, "computeType": compute_type, "beamSize": beam_size,
            "hotwords": args.hotwords,
            "gpuMemoryBeforeMiB": before_vram, "gpuMemoryLoadedMiB": loaded_vram,
            "meanCer": sum(row["cer"] for row in speech_rows) / max(1, len(speech_rows)),
            "meanWer": sum(row["wer"] for row in speech_rows) / max(1, len(speech_rows)),
            "meanRealTimeFactor": sum(row["realTimeFactor"] for row in rows) / len(rows),
            "hallucinationCount": sum(bool(row["hypothesis"]) for row in non_speech_rows),
            "suspectedHallucinationCount": sum(bool(row["suspectedHallucination"]) for row in rows),
            "emptyTranscriptionCount": sum(not row["hypothesis"] for row in speech_rows),
            "samples": rows,
        })
        del model
    report = {"schemaVersion": 1, "manifest": str(args.manifest.resolve()), "results": results}
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered, end="")


if __name__ == "__main__":
    main()
