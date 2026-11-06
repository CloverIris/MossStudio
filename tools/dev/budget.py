#!/usr/bin/env python3
"""MOSS-Image compute / memory budget estimator.

Numbers are derived from the published checkpoints and configs, not guessed:

    transformer  5.082 B params  (10.16 GB bf16, 463 tensors)
    text_encoder 8.393 B params  (16.79 GB bf16, 759 tensors)
    vae          ~0.125 B params (0.25 GB file)

Sources:
    https://huggingface.co/OpenMOSS-Team/MOSS-Image-Base/raw/main/transformer/config.json
    https://huggingface.co/OpenMOSS-Team/MOSS-Image-Base/raw/main/text_encoder/config.json
    https://huggingface.co/OpenMOSS-Team/MOSS-Image-Base/raw/main/transformer/diffusion_pytorch_model.safetensors.index.json

The FLOPs model is a linear-term + attention-term estimate. It is calibrated
against a measured MLX run (M4 Max, 1024x1024, 50 steps, CFG 3, bf16: 358 s),
which implies ~15.3 effective TFLOP/s for that device.

Usage:
    python3 tools/dev/budget.py                # full report
    python3 tools/dev/budget.py --markdown     # tables for docs
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass

# ---------------------------------------------------------------- model facts

DIT_PARAMS = 5.082e9
TE_PARAMS = 8.393e9
VAE_PARAMS = 0.125e9

DIT_DIM = 3072
DIT_LAYERS = 42
DIT_HEADS = 24
DIT_FFN = 8192
LATENT_CHANNELS = 128          # 32 VAE channels, 2x2 patchified
PATCH = 16                     # VAE 8x spatial * 2x2 patch
TEXT_TOKENS = 256              # typical caption + chat template
MAX_TEXT_TOKENS = 4096
SKIP_SAVING = 1 / DIT_LAYERS   # CFG negative branch skips block 22

VAE_DECODE_TFLOPS_1MPX = 2.5   # rough, +/-50%; conv decoder at 1024^2

# ------------------------------------------------------------------- modes

@dataclass(frozen=True)
class Mode:
    name: str
    steps: int
    cfg: bool
    note: str


MODES = (
    Mode("base-50", 50, True, "official defaults, 50 steps, CFG 3, block-22 skip"),
    Mode("base-20", 20, True, "quality/speed compromise, CFG 3"),
    Mode("dmd-8", 8, False, "lodestones 8-step DMD, CFG 1, custom sampler"),
)

# Effective sustained TFLOP/s. Measured values come from public MLX runs; the
# rest are scaled estimates and are labeled as such in the report.
@dataclass(frozen=True)
class Device:
    name: str
    tflops: float
    source: str


DEVICES = (
    Device("M4 Max 40c (MLX bf16)", 15.3, "measured: 358 s @1024^2/50/CFG3"),
    Device("M1 Max 24c (MLX bf16)", 5.3, "measured: 1028 s @1024^2/50/CFG3"),
    Device("M4 Pro 20c (est.)", 7.0, "scaled estimate"),
    Device("M3 10c (est.)", 2.6, "scaled estimate"),
    Device("RTX 4090 (est.)", 55.0, "scaled estimate"),
    Device("RTX 3060 12G (est.)", 18.0, "scaled estimate"),
    Device("A18 Pro / iPhone (est.)", 1.5, "scaled estimate"),
)


def tokens(height: int, width: int, text_tokens: int = TEXT_TOKENS) -> int:
    return (height // PATCH) * (width // PATCH) + text_tokens


def dit_forward_flops(seq: int) -> tuple[float, float, float]:
    """Return (linear, attention, total) FLOPs for one DiT forward."""
    linear = 2.0 * DIT_PARAMS * seq
    attention = 4.0 * seq * seq * DIT_DIM * DIT_LAYERS
    return linear, attention, linear + attention


def te_forward_flops(text_tokens: int = TEXT_TOKENS) -> float:
    return 2.0 * TE_PARAMS * text_tokens


def vae_decode_flops(height: int, width: int) -> float:
    return VAE_DECODE_TFLOPS_1MPX * 1e12 * (height * width) / (1024 * 1024)


def run_flops(height: int, width: int, mode: Mode, text_tokens: int = TEXT_TOKENS):
    seq = tokens(height, width, text_tokens)
    per_forward = dit_forward_flops(seq)[2]
    forwards = mode.steps * (2 - SKIP_SAVING if mode.cfg else 1)
    dit = per_forward * forwards
    te = te_forward_flops(text_tokens)
    vae = vae_decode_flops(height, width)
    return seq, per_forward, dit + te + vae


def weight_bytes(params: float, bits: int) -> float:
    return params * bits / 8


# ------------------------------------------------------------------- report

def human(seconds: float) -> str:
    if seconds < 90:
        return f"{seconds:.0f} s"
    if seconds < 5400:
        return f"{seconds / 60:.1f} min"
    return f"{seconds / 3600:.1f} h"


def print_report(markdown: bool) -> None:
    print("# MOSS-Image budget report\n" if markdown else "MOSS-Image budget report")

    print("## Weights\n" if markdown else "\nWeights")
    if markdown:
        print("| component | params | bf16 | int8 | int4 |")
        print("| --- | ---: | ---: | ---: | ---: |")
    for name, params in (
        ("DiT", DIT_PARAMS),
        ("text encoder (Qwen3.5-9B)", TE_PARAMS),
        ("VAE", VAE_PARAMS),
        ("total", DIT_PARAMS + TE_PARAMS + VAE_PARAMS),
    ):
        row = (
            f"| {name} | {params / 1e9:.3f} B | "
            f"{weight_bytes(params, 16) / 1e9:.2f} GB | "
            f"{weight_bytes(params, 8) / 1e9:.2f} GB | "
            f"{weight_bytes(params, 4) / 1e9:.2f} GB |"
        )
        print(row if markdown else row.replace("|", " "))

    print("\n## Sequence length and FLOPs per DiT forward\n" if markdown else "\nSequence length and FLOPs per DiT forward")
    if markdown:
        print("| resolution | image tokens | seq (text 256) | linear | attention | total |")
        print("| --- | ---: | ---: | ---: | ---: | ---: |")
    for h, w in ((512, 512), (768, 768), (1024, 1024), (1280, 768), (1024, 1376)):
        seq = tokens(h, w)
        linear, attn, total = dit_forward_flops(seq)
        cells = (
            f"| {h}x{w} | {(h // PATCH) * (w // PATCH)} | {seq} | "
            f"{linear / 1e12:.1f} TF | {attn / 1e12:.1f} TF | {total / 1e12:.1f} TF |"
        )
        print(cells if markdown else cells.replace("|", " "))

    print("\n## End-to-end time by device (estimates)\n" if markdown else "\nEnd-to-end time by device (estimates)")
    if markdown:
        print("| device | 512^2 base-50 | 512^2 dmd-8 | 1024^2 base-50 | 1024^2 dmd-8 |")
        print("| --- | ---: | ---: | ---: | ---: |")
    for dev in DEVICES:
        times = []
        for h, w, mode in (
            (512, 512, MODES[0]),
            (512, 512, MODES[2]),
            (1024, 1024, MODES[0]),
            (1024, 1024, MODES[2]),
        ):
            total = run_flops(h, w, mode)[2]
            times.append(human(total / (dev.tflops * 1e12)))
        if markdown:
            print(f"| {dev.name} | " + " | ".join(times) + " |")
        else:
            print(f"{dev.name:<28}" + "".join(f"{t:>10}" for t in times))

    print("\n## Memory profiles (staged: TE -> DiT -> VAE)\n" if markdown else "\nMemory profiles (staged: TE -> DiT -> VAE)")
    profiles = (
        ("8 GB", "int4", "int4 + block streaming", "int8", "~7.0 GB"),
        ("16 GB", "int4", "int8", "int8", "~9.8 GB"),
        ("24 GB", "int8", "int8", "int8", "~13.6 GB"),
        ("48 GB+", "bf16", "bf16", "bf16", "~27.5 GB"),
    )
    if markdown:
        print("| device memory | text encoder | DiT | VAE | weights resident |")
        print("| --- | --- | --- | --- | ---: |")
    for row in profiles:
        print(("| " + " | ".join(row) + " |") if markdown else f"{row[0]:<10}" + "".join(f"{c:<22}" for c in row[1:]))

    print("\n## Notes\n" if markdown else "\nNotes")
    for line in (
        "- FLOPs are per image, text encode and VAE decode included.",
        "- Attention FLOPs assume full (non-causal) attention over image+text tokens.",
        "- Effective TFLOP/s includes real-world utilization; peak hardware numbers are higher.",
        "- int8/int4 weight-only quantization does not reduce the FLOP count; it reduces memory traffic.",
        "- 16 GB machines need component staging (text encoder -> DiT -> VAE) and int4 text weights.",
    ):
        print(line if markdown else line[2:])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--markdown", action="store_true")
    args = parser.parse_args()
    print_report(args.markdown)


if __name__ == "__main__":
    main()
