"""Remote model task manager. Python stdlib supervises curl; no HF SDK is required."""
import concurrent.futures
import contextlib
import fcntl
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import quote, urljoin, urlsplit

ROOT = Path.home() / '.mossstudio' / 'downloads'
SLOTS = threading.Condition()
ACTIVE = 0


def now():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def load(path, default=None):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(dir=str(path.parent), prefix='.writing-')
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary)


def safe_file(root, relative):
    if (not relative or relative.startswith('/') or '\\' in relative or ':' in relative
            or any(part in ('', '.', '..') for part in relative.split('/'))
            or any(ord(char) < 32 for char in relative)):
        raise ValueError('Invalid model file path')
    target = root / relative
    try:
        target.resolve().relative_to(root.resolve())
    except ValueError:
        raise ValueError('Model file escapes its snapshot')
    return target


def curl_config(network):
    def quoted(value):
        if any(ord(char) < 32 for char in value):
            raise ValueError('Invalid curl configuration')
        return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'
    lines = []
    if network.get('proxy'):
        lines += ['proxy = ' + quoted(network['proxy']), 'noproxy = ""']
    if network.get('token'):
        lines += ['header = ' + quoted('Authorization: Bearer ' + network['token'])]
    return ('\n'.join(lines) + '\n').encode()


def curl_args():
    return ['curl', '-q', '--config', '-', '--location', '--fail', '--silent', '--show-error',
            '--proto', '=http,https', '--proto-redir', '=http,https', '--connect-timeout', '15']


def clean_error(error, network):
    text = str(error)
    for secret in (network.get('token'), network.get('proxy')):
        if secret:
            text = text.replace(secret, '[redacted]')
    return re.sub(r'(https?://)[^/@\s]+:[^/@\s]+@', r'\1[redacted]@', text)[-1600:]


def http_request(network, url, check=lambda: None):
    endpoint = network.get('endpoint', 'https://huggingface.co').rstrip('/')
    base = urlsplit(endpoint)
    target = urlsplit(url)
    if (target.scheme not in ('http', 'https') or target.netloc != base.netloc
            or not target.path.startswith(base.path.rstrip('/') + '/')):
        raise ValueError('HF query must use the configured endpoint')
    with tempfile.TemporaryDirectory(dir=str(ROOT)) as directory:
        headers = Path(directory) / 'headers'
        body = Path(directory) / 'body'
        with tempfile.TemporaryFile() as errors, body.open('wb') as output:
            process = subprocess.Popen(curl_args() + ['--max-time', '60', '--retry', '2',
                                       '--dump-header', str(headers), '--url', url],
                                       stdin=subprocess.PIPE, stdout=output, stderr=errors)
            try:
                process.stdin.write(curl_config(network))
                process.stdin.close()
                deadline = time.monotonic() + 210
                while process.poll() is None:
                    check()
                    if time.monotonic() > deadline:
                        raise RuntimeError('远端 HF 查询超时')
                    time.sleep(0.2)
                if process.returncode:
                    errors.seek(0)
                    raise RuntimeError(clean_error(errors.read().decode(errors='replace'), network))
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
        # Keep headers from the final response after proxy CONNECT/redirects.
        blocks = re.split(r'\r?\n\r?\n', headers.read_text(errors='replace').strip())
        final = next((block for block in reversed(blocks) if block.startswith('HTTP/')), '')
        parsed = dict((key.strip().lower(), value.strip()) for key, value in
                      (line.split(':', 1) for line in final.splitlines()[1:] if ':' in line))
        return {'body': body.read_text(), 'headers': parsed}


def resolve_manifest(spec, network, check):
    repo = spec['repo']
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repo):
        raise ValueError('Invalid HF repository')
    base = network['endpoint'].rstrip('/')
    meta = json.loads(http_request(network, base + '/api/models/' + repo + '/revision/'
                                   + quote(spec.get('revision') or 'main', safe=''), check)['body'])
    sha = meta.get('sha', '')
    if not re.fullmatch(r'[a-f0-9]{40,64}', sha):
        raise ValueError('HF returned an invalid revision')
    url = base + '/api/models/' + repo + '/tree/' + sha + '?recursive=true&limit=1000'
    files, seen = [], set()
    while url:
        if url in seen:
            raise ValueError('Invalid HF pagination')
        seen.add(url)
        check()
        response = http_request(network, url, check)
        for entry in json.loads(response['body']):
            if entry.get('type') != 'file':
                continue
            safe_file(Path('/model-cache'), entry['path'])
            lfs = entry.get('lfs') or {}
            size = lfs.get('size', entry.get('size'))
            oid = lfs.get('oid') or entry.get('oid')
            if not isinstance(size, int) or size < 0:
                raise ValueError('HF returned an invalid file size')
            if oid and not re.fullmatch(r'(?:[a-f0-9]{40}|[a-f0-9]{64})', oid):
                raise ValueError('HF returned an invalid file hash')
            files.append({'path': entry['path'], 'size': size, 'oid': oid})
        next_link = re.search(r'<([^>]+)>;\s*rel="next"', response['headers'].get('link', ''))
        url = urljoin(url, next_link.group(1)) if next_link else None
    patterns = spec.get('files') or []
    for pattern in patterns:
        if not any(fnmatch.fnmatchcase(file['path'], pattern) for file in files):
            raise ValueError('Repository is missing required file: ' + pattern)
    files = [file for file in files if not patterns or any(
        fnmatch.fnmatchcase(file['path'], pattern) for pattern in patterns)]
    if not files:
        raise ValueError('No matching model files')
    root = Path(spec['modelsRoot']).expanduser().resolve()
    cache = root / 'hf' / 'hub' / ('models--' + repo.replace('/', '--'))
    return {'sha': sha, 'files': files, 'path': str(cache / 'snapshots' / sha),
            'cache': str(cache), 'endpoint': base}


class Stopped(Exception):
    pass


def check_control(directory, generation):
    control = load(directory / 'control.json', {})
    if control.get('desired') != 'running' or control.get('generation') != generation:
        raise Stopped()


def file_size(path):
    try:
        return path.stat().st_size
    except FileNotFoundError:
        return 0


def verify(path, file, check):
    if not path.is_file() or file_size(path) != file['size']:
        return False
    oid = file.get('oid')
    if not oid:
        return True
    digest = hashlib.sha256() if len(oid) == 64 else hashlib.sha1()
    if len(oid) == 40:
        digest.update(('blob %d\0' % file['size']).encode())
    with path.open('rb') as stream:
        while True:
            check()
            chunk = stream.read(4 * 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest() == oid


@contextlib.contextmanager
def download_slot(check):
    global ACTIVE
    with SLOTS:
        while ACTIVE >= max(1, min(16, load(ROOT / 'network.json', {}).get('concurrency', 4))):
            check()
            SLOTS.wait(0.25)
        check()
        ACTIVE += 1
    try:
        yield
    finally:
        with SLOTS:
            ACTIVE -= 1
            SLOTS.notify_all()


def download_file(directory, generation, manifest, spec, file, network, progress, guard, abort):
    def check():
        if abort.is_set():
            raise Stopped()
        check_control(directory, generation)
    target = safe_file(Path(manifest['path']), file['path'])
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_name(target.name + '.part')
    # Components in the same repo may share files; hold a per-file lock through rename.
    with target.with_name(target.name + '.moss-lock').open('a') as lock:
        while True:
            check()
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                time.sleep(0.25)
        with download_slot(check):
            with guard:
                progress[file['path']] = 'verifying'
            if verify(target, file, check):
                with guard:
                    progress[file['path']] = 'done'
                return
            if target.exists():
                if not part.exists():
                    os.replace(target, part)
                else:
                    target.unlink()
            if file_size(part) > file['size']:
                part.unlink()
            url = manifest['endpoint'] + '/' + spec['repo'] + '/resolve/' + manifest['sha'] + '/' + quote(file['path'], safe='/')
            for attempt in range(4):
                check()
                if verify(part, file, check):
                    break
                if part.exists() and file_size(part) == file['size']:
                    part.unlink()  # A complete-size file with a bad hash cannot be resumed.
                with guard:
                    progress[file['path']] = 'running'
                with tempfile.TemporaryFile() as errors:
                    process = subprocess.Popen(curl_args() + ['--retry', '3', '--retry-connrefused',
                        '--speed-limit', '1024', '--speed-time', '60', '--continue-at', '-',
                        '--output', str(part), '--write-out', '%{http_code}', '--url', url],
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors)
                    try:
                        process.stdin.write(curl_config(network))
                        process.stdin.close()
                        while process.poll() is None:
                            check()
                            time.sleep(0.2)
                        status = process.stdout.read().decode(errors='replace').strip()[-3:]
                    finally:
                        if process.poll() is None:
                            process.terminate()
                            try:
                                process.wait(timeout=5)
                            except subprocess.TimeoutExpired:
                                process.kill()
                                process.wait()
                        process.stdout.close()
                    check()
                    if process.returncode:
                        if (process.returncode in (33, 36) or status == '416') and attempt < 3:
                            with contextlib.suppress(FileNotFoundError):
                                part.unlink()
                            continue
                        if process.returncode in (5, 6, 7, 18, 28, 52, 55, 56) and attempt < 3:
                            check()
                            time.sleep(attempt + 1)
                            continue
                        errors.seek(0)
                        raise RuntimeError(clean_error(errors.read().decode(errors='replace'), network)
                                           or 'curl exited with code %s' % process.returncode)
                with guard:
                    progress[file['path']] = 'verifying'
                if verify(part, file, check):
                    break
                if file_size(part) >= file['size']:
                    part.unlink()
            else:
                raise RuntimeError('File size/hash verification failed: ' + file['path'])
            check()
            os.replace(part, target)
            with guard:
                progress[file['path']] = 'done'


def run_task(directory, generation):
    spec = load(directory / 'request.json')
    network = load(ROOT / 'network.json', {})
    task = dict(spec['task'], state='queued', speedBps=0, generation=generation)
    task.pop('error', None)
    task.pop('connectionError', None)
    progress, guard, abort = {}, threading.Lock(), threading.Event()
    check = lambda: check_control(directory, generation)

    def publish(**patch):
        task.update(patch, updatedAt=now())
        save(directory / 'state.json', task)

    try:
        publish(currentFile='正在查询 HF 文件清单')
        manifest = load(directory / 'manifest.json')
        if not manifest:
            manifest = resolve_manifest(spec, network, check)
            check()
            save(directory / 'manifest.json', manifest)
        # Network preferences may change on retry; the pinned revision/files stay fixed.
        manifest['endpoint'] = network['endpoint'].rstrip('/')
        check()
        root = Path(manifest['path'])
        root.mkdir(parents=True, exist_ok=True)
        files = manifest['files']
        remaining = sum(max(0, file['size'] - min(file['size'], file_size(safe_file(root, file['path']))
                            + file_size(safe_file(root, file['path'] + '.part')))) for file in files)
        if shutil.disk_usage(root).free < remaining + 64 * 1024 * 1024:
            raise RuntimeError('远端模型磁盘空间不足')
        publish(remotePath=str(root), revision=manifest['sha'], filesTotal=len(files),
                totalBytes=sum(file['size'] for file in files), filesDone=0, state='running')
        previous_bytes, previous_time = None, time.monotonic()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            futures = [pool.submit(download_file, directory, generation, manifest, spec, file,
                                   network, progress, guard, abort) for file in files]
            failure = None
            while True:
                # A failed file stops the rest of this task without affecting other models.
                errors = [future.exception() for future in futures if future.done() and future.exception()]
                if errors:
                    failure = errors[0]
                    abort.set()
                    break
                check()
                with guard:
                    states = dict(progress)
                downloaded = sum(file['size'] if states.get(file['path']) == 'done' else
                    min(file['size'], max(file_size(safe_file(root, file['path'])),
                                         file_size(safe_file(root, file['path'] + '.part')))) for file in files)
                current_time = time.monotonic()
                speed = max(0, (downloaded - previous_bytes) / max(0.01, current_time - previous_time)) if previous_bytes is not None else 0
                complete = sum(state == 'done' for state in states.values())
                current = [name for name, state in states.items() if state in ('running', 'verifying')]
                publish(bytes=downloaded, filesDone=complete, speedBps=speed,
                        state='verifying' if current and all(states[name] == 'verifying' for name in current) else 'running',
                        currentFile=', '.join(current[:3]) or '等待下载')
                previous_bytes, previous_time = downloaded, current_time
                if all(future.done() for future in futures):
                    break
                time.sleep(0.75)
            if failure:
                # Cancel queued futures, then let active writers stop using a task-local signal.
                for future in futures:
                    future.cancel()
                raise failure
        check()
        refs = Path(manifest['cache']) / 'refs'
        refs.mkdir(parents=True, exist_ok=True)
        revision = re.sub(r'[^A-Za-z0-9._-]', '_', spec.get('revision') or 'main')
        (refs / revision).write_text(manifest['sha'] + '\n')
        publish(state='done', bytes=task['totalBytes'], filesDone=len(files), speedBps=0, currentFile='')
    except Stopped:
        control = load(directory / 'control.json', {})
        publish(state='canceled' if control.get('desired') == 'canceled' else 'paused', speedBps=0)
    except Exception as error:
        publish(state='error', speedBps=0, error=clean_error(error, network))


def task_list():
    tasks = []
    for directory in sorted(ROOT.glob('task-*')):
        state = load(directory / 'state.json')
        control = load(directory / 'control.json', {})
        if not state:
            continue
        if control.get('desired') in ('paused', 'canceled'):
            state.update(state=control['desired'], speedBps=0)
        elif control.get('generation', 0) != state.get('generation', 0):
            state.update(state='queued', speedBps=0)
        state.pop('generation', None)
        tasks.append(state)
    return tasks


def manager():
    with (ROOT / 'manager.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        running = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            while True:
                for directory, future in list(running.items()):
                    if future.done():
                        future.result()
                        del running[directory]
                for directory in sorted(ROOT.glob('task-*')):
                    control = load(directory / 'control.json', {})
                    state = load(directory / 'state.json', {})
                    if directory in running or control.get('desired') != 'running':
                        continue
                    generation = control.get('generation', 0)
                    if state.get('generation') == generation and state.get('state') in ('done', 'error', 'paused'):
                        continue
                    running[directory] = pool.submit(run_task, directory, generation)
                time.sleep(0.5)


def ensure_manager():
    with (ROOT / 'manager.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
    with (ROOT / 'manager.log').open('ab') as log:
        subprocess.Popen([sys.executable, str(Path(__file__).resolve()), 'serve'],
                         stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                         start_new_session=True, close_fds=True)


def main(request):
    os.umask(0o077)
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not shutil.which('curl'):
        raise RuntimeError('远端需要安装 curl')
    action = request['action']
    network = request.get('network')
    if action == 'http':
        return http_request(network, request['url'])
    if network:
        save(ROOT / 'network.json', network)
    if action == 'start':
        spec = request['spec']
        key = hashlib.sha256(spec['task']['id'].encode()).hexdigest()
        directory = ROOT / ('task-' + key)
        directory.mkdir(mode=0o700, exist_ok=True)
        with (directory / 'request.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            state = load(directory / 'state.json', {})
            control = load(directory / 'control.json', {})
            if not state or state.get('state') in ('error', 'paused', 'canceled') or control.get('desired') != 'running':
                save(directory / 'request.json', spec)
                if not state:
                    save(directory / 'state.json', dict(spec['task'], generation=0))
                save(directory / 'control.json', {'desired': 'running', 'generation': control.get('generation', 0) + 1})
    elif action == 'control':
        key = hashlib.sha256(request['taskId'].encode()).hexdigest()
        directory = ROOT / ('task-' + key)
        if not (directory / 'request.json').is_file():
            raise ValueError('远端下载任务不存在')
        with (directory / 'request.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            control = load(directory / 'control.json', {})
            desired = {'pause': 'paused', 'resume': 'running', 'cancel': 'canceled'}.get(request['operation'])
            if not desired:
                raise ValueError('Invalid download control')
            save(directory / 'control.json', {'desired': desired, 'generation': control.get('generation', 0) + 1})
    elif action != 'list':
        raise ValueError('Invalid worker command')
    ensure_manager()
    return task_list()


if __name__ == '__main__':
    os.umask(0o077)
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    if len(sys.argv) > 1 and sys.argv[1] == 'serve':
        manager()
    else:
        try:
            request = json.load(sys.stdin)
            print(json.dumps({'ok': True, 'result': main(request)}, ensure_ascii=False))
        except Exception as error:
            print(json.dumps({'ok': False, 'error': clean_error(error, locals().get('request', {}).get('network', {}))}, ensure_ascii=False))
            sys.exit(1)
