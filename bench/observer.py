"""Forward and measure execution and Jev traffic within one shared call budget."""
import json
import os
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from common import numeric, usage_of, write_json

JEV_UPSTREAM = 'https://opencode.ai/inference/v1/systemone'


class CaseObserver:
    def __init__(self, output, request_limit=64, pool='http://127.0.0.1:8788/v1/chat/completions'):
        self.output = output
        self.limit = request_limit
        self.pool = pool
        self.calls = []
        self.account_labels = {}
        self.lock = threading.Lock()
        self.stopped = False
        self.execution_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.jev_opener = urllib.request.build_opener(urllib.request.ProxyHandler(urllib.request.getproxies()))

    def flush(self):
        with self.lock:
            write_json(self.output, self.calls)

    def handler(self):
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                if self.path not in ('/jev', '/v1/chat/completions'):
                    self.send_error(404)
                    return
                raw = self.rfile.read(int(self.headers['Content-Length']))
                owner.forward(self, raw, self.path == '/jev')

        return Handler

    def forward(self, client, raw, jev):
        try:
            body = json.loads(raw)
        except ValueError:
            body = None
        if not isinstance(body, dict):
            client.send_error(400, 'Expected a JSON object')
            return
        if not jev:
            requested = numeric(body.get('max_tokens', body.get('max_completion_tokens')))
            body['max_tokens'] = min(requested, 16384) if requested is not None and requested > 0 else 16384
            body.pop('max_completion_tokens', None)
            if body.get('stream'):
                body['stream_options'] = {'include_usage': True}
            raw = json.dumps(body).encode()
        role = 'jev' if jev else client.headers.get('x-bench-role')
        if not jev and client.headers.get('x-deepseek-harness-compact') == '1':
            role = 'compaction'
        session = client.headers.get('x-wb-session-id') or client.headers.get('x-deepseek-harness-session-id')
        record = {'kind': 'jev' if jev else 'execution', 'role': role,
                  'model': body.get('model'), 'session': session, 'startedUnix': time.time()}
        with self.lock:
            if self.stopped or len(self.calls) >= self.limit:
                client.send_error(429, 'Task model-request limit reached or solver stopped')
                return
            self.calls.append(record)
        headers = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}
        if jev:
            headers['Authorization'] = 'Bearer ' + os.environ['JEV_API_KEY']
            headers['User-Agent'] = client.headers.get('User-Agent') or 'node'
        elif session:
            headers['x-wb-session-id'] = session
        request = urllib.request.Request(JEV_UPSTREAM if jev else self.pool, data=raw, headers=headers)
        response_raw = bytearray()
        started = time.perf_counter()
        sent_headers = False
        try:
            try:
                response = (self.jev_opener if jev else self.execution_opener).open(request, timeout=180)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                record['httpStatus'] = response.code
                account = response.headers.get('x-wb-account')
                if account is not None:
                    with self.lock:
                        if account not in self.account_labels:
                            self.account_labels[account] = f'account-{len(self.account_labels) + 1}'
                        record['account'] = self.account_labels[account]
                client.send_response(response.code)
                client.send_header('Content-Type', response.headers.get('Content-Type', 'application/json'))
                client.send_header('Connection', 'close')
                client.end_headers()
                sent_headers = True
                connected = True
                while part := response.read1(65536):
                    response_raw.extend(part)
                    if connected:
                        try:
                            client.wfile.write(part)
                            client.wfile.flush()
                        except OSError:
                            connected = False
        except (OSError, urllib.error.URLError) as error:
            record['transportError'] = type(error).__name__
            if not sent_headers:
                client.send_error(502, 'Upstream transport failed')
        finally:
            self.capture_usage(record, response_raw)
            record['elapsedSeconds'] = round(time.perf_counter() - started, 4)
            self.flush()
            client.close_connection = True

    @staticmethod
    def capture_usage(record, raw):
        parts = [line[5:] for line in raw.splitlines() if line.startswith(b'data:')]
        for part in parts or [raw]:
            try:
                item = json.loads(part)
            except ValueError:
                continue
            if not isinstance(item, dict):
                continue
            if isinstance(item.get('model'), str):
                record['actualModel'] = item['model']
            if isinstance(item.get('usage'), dict):
                record['usage'] = item['usage']
                record.update({key + 'Tokens': value for key, value in usage_of(item).items() if value is not None})

    def start(self):
        class Server(ThreadingHTTPServer):
            daemon_threads = False
        self.server = Server(('127.0.0.1', 0), self.handler())
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self.server.server_address[1]

    def stop_admitting(self):
        with self.lock:
            self.stopped = True

    def close(self):
        self.stop_admitting()
        self.server.shutdown()
        self.server.server_close()
        self.flush()
