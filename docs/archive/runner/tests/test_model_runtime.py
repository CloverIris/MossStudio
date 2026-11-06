import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest


class ModelRuntimeTest(unittest.TestCase):
    def test_precision_and_legacy_passthrough(self):
        module_path = Path(__file__).resolve().parents[1] / 'model_runtime.py'
        spec = importlib.util.spec_from_file_location('clover_test_model_runtime', module_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        calls = []
        original = dict(sys.modules)
        try:
            runtime = types.ModuleType('inference_runtime')
            runtime.load_pipeline = lambda model, **kw: ('legacy', model, kw)
            sys.modules['inference_runtime'] = runtime
            sys.modules['torch'] = types.SimpleNamespace(bfloat16='bf16', float16='fp16', float32='fp32')
            sys.modules['diffusers'] = types.SimpleNamespace(DiffusionPipeline=types.SimpleNamespace(from_pretrained=lambda *a, **kw: calls.append((a, kw))))
            module.install_loader()
            self.assertEqual(runtime.load_pipeline('team/legacy')[0], 'legacy')
            with tempfile.TemporaryDirectory() as directory:
                Path(directory, 'clover_model.json').write_text(json.dumps({'version': 1, 'components': [
                    {'role': 'dit', 'precision': 'fp16'}, {'role': 'text_encoder', 'precision': 'bf16'}, {'role': 'vae', 'precision': 'fp32'},
                ]}), encoding='utf-8')
                runtime.load_pipeline(directory)
                self.assertTrue(calls[-1][1]['local_files_only'])
                self.assertEqual(calls[-1][1]['torch_dtype'], {'default': 'bf16', 'transformer': 'fp16', 'text_encoder': 'bf16', 'vae': 'fp32'})
        finally:
            for name in ['inference_runtime', 'torch', 'diffusers']:
                if name in original: sys.modules[name] = original[name]
                else: sys.modules.pop(name, None)


if __name__ == '__main__':
    unittest.main()
