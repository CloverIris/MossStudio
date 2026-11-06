import builtins
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


RUNNER = Path(__file__).resolve().parents[1] / 'runner.py'


def load_runner():
    spec = importlib.util.spec_from_file_location('clover_test_runner', RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RunnerStartupTest(unittest.TestCase):
    def test_native_imports_finish_before_stdin_reader_starts(self):
        runner = load_runner()
        events = []
        original_import = builtins.__import__
        torch = types.SimpleNamespace(
            backends=types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: False)),
            cuda=types.SimpleNamespace(is_available=lambda: False), float32='fp32', float16='fp16',
        )

        def load_pipeline(*args, **kwargs):
            events.append('load pipeline')
            raise RuntimeError('stop before loading weights')

        modules = {
            'torch': torch,
            'model_runtime': types.SimpleNamespace(install_loader=lambda: events.append('install loader')),
            'inference_runtime': types.SimpleNamespace(load_pipeline=load_pipeline, generate_with_progress=None),
        }

        def import_module(name, *args, **kwargs):
            if name in modules:
                events.append(name)
                return modules[name]
            return original_import(name, *args, **kwargs)

        with patch('builtins.__import__', side_effect=import_module), \
                patch.object(runner.threading, 'Thread') as thread, \
                patch.object(runner, 'emit') as emit:
            thread.return_value.start.side_effect = lambda: events.append('start reader')
            with self.assertRaisesRegex(RuntimeError, 'stop before loading weights'):
                runner.real({})
        self.assertLess(events.index('torch'), events.index('start reader'))
        self.assertLess(events.index('inference_runtime'), events.index('start reader'))
        self.assertLess(events.index('start reader'), events.index('load pipeline'))
        self.assertEqual(emit.call_args_list[0].args[0]['type'], 'hello')
        self.assertEqual(sum(call.args[0]['type'] == 'hello' for call in emit.call_args_list), 1)

    def test_import_failures_emit_startup_log_and_specific_error(self):
        runner = load_runner()
        original_import = builtins.__import__

        def import_module(name, *args, **kwargs):
            if name == 'torch':
                raise ModuleNotFoundError("No module named 'torch'")
            return original_import(name, *args, **kwargs)

        with patch.object(sys, 'argv', ['runner.py', '--job', 'fixture.json']), \
                patch.object(Path, 'read_text', return_value='{}'), \
                patch('builtins.__import__', side_effect=import_module), \
                patch.object(runner.threading, 'Thread') as thread, \
                patch.object(runner, 'emit') as emit:
            with self.assertRaises(SystemExit) as exit:
                runner.main()
        self.assertEqual(exit.exception.code, 1)
        thread.assert_not_called()
        events = [call.args[0] for call in emit.call_args_list]
        self.assertEqual([event['type'] for event in events], ['hello', 'log', 'error', 'bye'])
        self.assertEqual(events[2]['code'], 'E_MODULE')

    def test_simulated_runner_still_receives_cancel_commands(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory) / 'job.json'
            job.write_text(json.dumps({'job_id': 'startup-test', 'steps': 1}), encoding='utf-8')
            result = subprocess.run(
                [sys.executable, str(RUNNER), '--job', str(job), '--simulate'],
                input='@@CLOVER@@ {"cmd":"cancel"}\n', capture_output=True,
                text=True, encoding='utf-8', timeout=10,
                env={**os.environ, 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8'},
            )
        events = [json.loads(line.removeprefix('@@CLOVER@@ ')) for line in result.stdout.splitlines()
                  if line.startswith('@@CLOVER@@ ')]
        self.assertEqual(result.returncode, 130, result.stderr)
        self.assertIn('ready', [event['type'] for event in events])
        self.assertIn('canceled', [event['type'] for event in events])
        self.assertNotIn('result', [event['type'] for event in events])


if __name__ == '__main__':
    unittest.main()
