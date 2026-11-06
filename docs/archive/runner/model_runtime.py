"""Local component precision adapter used by the MossStudio runner."""
from __future__ import annotations

import json
from pathlib import Path


def install_loader():
    import inference_runtime

    original = inference_runtime.load_pipeline

    def load_pipeline(model, local_files_only=False):
        root = Path(str(model)).expanduser()
        manifest_path = root / "clover_model.json"
        if not manifest_path.is_file():
            return original(model, local_files_only=local_files_only)
        import diffusers
        import torch

        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("version") != 1:
            raise ValueError("Unsupported Clover model manifest")
        dtypes = {"bf16": torch.bfloat16, "fp16": torch.float16, "fp32": torch.float32}
        roles = {"dit": "transformer", "text_encoder": "text_encoder", "vae": "vae"}
        precision = {"default": torch.bfloat16, "vae": torch.float32}
        for component in manifest["components"]:
            role = component["role"]
            if role in roles:
                precision[roles[role]] = torch.float32 if role == "vae" else dtypes[component["precision"]]
        return diffusers.DiffusionPipeline.from_pretrained(
            str(root.resolve()), custom_pipeline="pipeline_moss_image",
            trust_remote_code=True, local_files_only=True, torch_dtype=precision,
        )

    inference_runtime.load_pipeline = load_pipeline
