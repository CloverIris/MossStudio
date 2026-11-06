#!/usr/bin/env python3
"""MossStudio thin runner.

Loads the official MOSS-Image pipeline, runs one job, and emits NDJSON events on
stdout. It never reimplements the model: it is a small orchestration shim so the
launcher can show stages/progress without parsing tqdm.

Protocol: every event is a single line prefixed with `@@CLOVER@@ ` and a JSON object.
The full contract lives in docs/archive/contracts/runner-protocol.md.
"""
from __future__ import annotations

import argparse
import json
import os
import struct
import sys
import threading
import time
import traceback
import zlib
from pathlib import Path

PREFIX = "@@CLOVER@@ "
CANCEL = threading.Event()


class Canceled(Exception):
    pass


def emit(payload):
    sys.stdout.write(PREFIX + json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(message, level="info"):
    emit({"type": "log", "level": level, "message": str(message)[:4000]})


def read_commands():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        if line.startswith(PREFIX):
            line = line[len(PREFIX):]
        try:
            command = json.loads(line)
        except Exception:
            continue
        if command.get("cmd") == "cancel":
            CANCEL.set()
            log("收到取消请求，将在当前 step 结束前停止", "warning")
        elif command.get("cmd") == "shutdown":
            CANCEL.set()


def check_cancel():
    if CANCEL.is_set():
        raise Canceled()


def write_png(path: Path, width: int = 64, height: int = 64):
    rows = []
    for y in range(height):
        row = bytearray([0])
        for x in range(width):
            row.extend((20 + x % 60, 70 + y % 50, 240))
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 6)

    def chunk(tag, payload):
        body = tag + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", raw)
        + chunk(b"IEND", b"")
    )


def simulate(job):
    threading.Thread(target=read_commands, daemon=True).start()
    width = int(job.get("width", 64))
    height = int(job.get("height", 64))
    steps = max(1, int(job.get("steps", 8)))
    emit({"type": "hello", "protocol": 1, "runner_version": "0.1.0", "simulate": True})
    log("模拟模式：不加载模型权重，只验证任务编排与事件流")
    emit({"type": "ready", "device": "simulated", "dtype": "float16", "capabilities": ["progress", "cancel"]})
    time.sleep(0.3)
    emit({"type": "stage", "name": "text"})
    time.sleep(0.5)
    emit({"type": "stage", "name": "denoise"})
    for step in range(1, steps + 1):
        check_cancel()
        time.sleep(0.25)
        emit(
            {
                "type": "progress",
                "stage": "denoise",
                "current": step,
                "total": steps,
                "percent": round(step / steps * 100, 1),
                "eta_ms": int((steps - step) * 250),
            }
        )
    log("模拟采样完成，开始解码")
    emit({"type": "stage", "name": "decode"})
    time.sleep(0.6)
    output_dir = Path(job.get("output_dir", "outputs"))
    target = output_dir / f"simulated-{job.get('job_id', 'job')}.png"
    write_png(target, min(width, 512), min(height, 512))
    (target.with_suffix(".json")).write_text(
        json.dumps(
            {
                "prompt": job.get("prompt", ""),
                "negative_prompt": job.get("negative_prompt", ""),
                "seed": job.get("seed", 0),
                "width": width,
                "height": height,
                "simulated": True,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    log(f"写入模拟输出：{target}")
    emit(
        {
            "type": "result",
            "images": [{"path": str(target), "width": width, "height": height, "seed": job.get("seed", 0)}],
            "timings": {"load_ms": 0, "text_encode_ms": 500, "denoise_ms": steps * 250, "decode_ms": 600, "total_ms": steps * 250 + 1100},
        }
    )
    emit({"type": "bye", "exit_code": 0})


def real(job):
    emit({"type": "hello", "protocol": 1, "runner_version": "0.1.0"})
    log("初始化 PyTorch 与推理依赖")
    import torch

    if CANCEL.is_set():
        raise Canceled()

    model = job.get("model") or {}
    if isinstance(model, dict):
        model = model.get("repo") or model.get("path") or "OpenMOSS-Team/MOSS-Image-SFT"
    model = str(model)

    device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device in ("mps", "cuda") else torch.float32

    emit({"type": "stage", "name": "load"})
    log(f"加载 pipeline：{model}（device={device}, dtype={dtype}）")

    # The instance directory is cwd; allow importing the official modules directly.
    sys.path.insert(0, os.getcwd())
    from model_runtime import install_loader
    install_loader()
    from inference_runtime import generate_with_progress, load_pipeline

    # On Windows, importing native libraries with a blocked stdin reader can hang.
    threading.Thread(target=read_commands, daemon=True).start()

    pipe = load_pipeline(model, local_files_only=False)
    pipe.to(device)
    if hasattr(pipe, "set_progress_bar_config"):
        pipe.set_progress_bar_config(disable=True)
    log("pipeline 加载完成")
    emit({"type": "ready", "device": device, "dtype": str(dtype), "capabilities": ["progress", "cancel"]})

    steps = max(1, int(job.get("steps", 50)))
    cfg = float(job.get("guidance_scale", 3))
    seed = int(job.get("seed", 0))
    width = int(job.get("width", 1024))
    height = int(job.get("height", 1024))

    try:
        generator = torch.Generator(device=device).manual_seed(seed)
    except Exception:
        generator = torch.Generator(device="cpu").manual_seed(seed)

    def report_stage(stage):
        emit({"type": "stage", "name": "text" if stage == "encode" else stage})

    def report_step(pipe_obj, index, timestep, callback_kwargs):
        check_cancel()
        completed = index + 1
        emit(
            {
                "type": "progress",
                "stage": "denoise",
                "current": completed,
                "total": steps,
                "percent": round(completed / steps * 100, 1),
            }
        )
        return callback_kwargs

    output = generate_with_progress(
        pipe,
        report_stage,
        report_step,
        prompt=job.get("prompt", ""),
        negative_prompt=job.get("negative_prompt", ""),
        width=width,
        height=height,
        num_inference_steps=steps,
        guidance_scale=cfg,
        max_sequence_length=int(job.get("options", {}).get("max_sequence_length", 4096)),
        generator=generator,
        output_type="pil",
    )

    emit({"type": "stage", "name": "save"})
    output_dir = Path(job.get("output_dir", "outputs"))
    output_dir.mkdir(parents=True, exist_ok=True)
    images = getattr(output, "images", output)
    if not isinstance(images, (list, tuple)):
        images = [images]
    records = []
    for index, image in enumerate(images):
        target = output_dir / f"{job.get('job_id', 'job')}-{index + 1}.png"
        image.save(target)
        (target.with_suffix(".json")).write_text(
            json.dumps(
                {
                    "prompt": job.get("prompt", ""),
                    "negative_prompt": job.get("negative_prompt", ""),
                    "seed": seed,
                    "width": width,
                    "height": height,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        records.append({"path": str(target), "width": width, "height": height, "seed": seed})
    emit({"type": "result", "images": records})
    emit({"type": "bye", "exit_code": 0})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", required=True)
    parser.add_argument("--simulate", action="store_true")
    args = parser.parse_args()

    job = json.loads(Path(args.job).read_text(encoding="utf-8"))
    try:
        if args.simulate or job.get("mode") == "simulate":
            simulate(job)
        else:
            real(job)
    except Canceled:
        emit({"type": "canceled", "at_stage": "denoise"})
        emit({"type": "bye", "exit_code": 130})
        sys.exit(130)
    except ModuleNotFoundError as error:
        emit({"type": "error", "code": "E_MODULE", "message": str(error), "fatal": True, "traceback": traceback.format_exc()[-8000:]})
        emit({"type": "bye", "exit_code": 1})
        sys.exit(1)
    except Exception as error:
        message = str(error)
        code = "E_OOM" if "out of memory" in message.lower() else "E_LOAD" if "load" in message.lower() else "E_INTERNAL"
        emit({"type": "error", "code": code, "message": message[:2000], "fatal": True, "traceback": traceback.format_exc()[-8000:]})
        emit({"type": "bye", "exit_code": 1})
        sys.exit(1)


if __name__ == "__main__":
    main()
