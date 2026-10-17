"""Forward and measure execution, Jev and native OpenCode traffic within one shared call budget."""
import gzip
import json
import os
import threading
import time
import urllib.error
import urllib.request
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from common import cost_usd, numeric, usage_of, write_json

JEV_UPSTREAM = 'https://opencode.ai/inference/v1/systemone'
OPENCODE_UPSTREAM = 'https://opencode.ai/zen/go'
SKIPPED_HEADERS = ('host', 'content-length', 'connection', 'transfer-encoding', 'keep-alive',
                   'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade')
CREDENTIAL_HEADERS = ('authorization', 'x-api-key')


def content_body(raw, encoding, encode=False):
    encodings = [value.strip().lower() for value in encoding.split(',')]
    for value in encodings if encode else reversed(encodings):
        if value in ('', 'identity'):
            continue
        if value == 'gzip':
            raw = gzip.compress(raw) if encode else zlib.decompressobj(31).decompress(raw)
        elif value == 'deflate':
            if encode:
                raw = zlib.compress(raw)
            else:
                try:
                    raw = zlib.decompressobj().decompress(raw)
                except zlib.error:
                    raw = zlib.decompressobj(-15).decompress(raw)
        else:
            raise ValueError('Unsupported content encoding')
    return raw


class CaseObserver:
    def __init__(self, output, request_limit=64, pool='http://127.0.0.1:8788/v1/chat/completions',
                 max_usd=0.50):
        self.output = output
        self.limit = request_limit
        self.pool = pool
        self.max_usd = max_usd
        self.spend = 0.0
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
                if self.path not in ('/jev', '/v1/chat/completions') and not self.path.startswith('/go/'):
                    self.send_error(404)
                    return
                raw = self.rfile.read(int(self.headers['Content-Length']))
                owner.forward(self, raw, self.path)

        return Handler

    def forward(self, client, raw, path):
        jev = path == '/jev'
        opencode = path.startswith('/go/')
        upstream = 'jev' if jev else 'opencode-go' if opencode else 'workbuddy'
        encoding = client.headers.get('Content-Encoding', '') if opencode else ''
        try:
            body = json.loads(content_body(raw, encoding))
        except (ValueError, zlib.error):
            body = None
        if not isinstance(body, dict):
            client.send_error(400, 'Expected a JSON object')
            return
        if opencode:
            changed = False
            for field in ('max_tokens', 'max_output_tokens'):
                cap = numeric(body.get(field))
                if cap is not None and cap > 16384:
                    body[field] = 16384
                    changed = True
            if changed:
                raw = content_body(json.dumps(body).encode(), encoding, encode=True)
        elif not jev:
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
        record = {'kind': 'jev' if jev else 'execution', 'role': role, 'upstream': upstream,
                  'model': body.get('model'), 'session': session, 'startedUnix': time.time()}
        if opencode and path.split('?', 1)[0].endswith('/messages'):
            record['usageProtocol'] = 'anthropic-messages'
        with self.lock:
            if self.stopped or len(self.calls) >= self.limit:
                client.send_error(429, 'Task model-request limit reached or solver stopped')
                return
            if opencode and self.spend >= self.max_usd:
                record.update(httpStatus=429, costUSD=None, refused='spend-cap')
                self.calls.append(record)
                refuse = True
            else:
                self.calls.append(record)
                refuse = False
        if refuse:
            self.flush()
            client.send_error(429, 'Paid spend cap reached')
            return
        if opencode:
            connection_headers = tuple(name.strip().lower() for name in client.headers.get('Connection', '').split(','))
            headers = {name: value for name, value in client.headers.items()
                       if name.lower() not in SKIPPED_HEADERS + CREDENTIAL_HEADERS + connection_headers}
            key = os.environ['OPENCODE_API_KEY']
            if 'Authorization' in client.headers:
                headers['Authorization'] = 'Bearer ' + key
            if 'x-api-key' in client.headers:
                headers['x-api-key'] = key
            target = OPENCODE_UPSTREAM + path[len('/go'):]
        else:
            headers = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}
            if jev:
                headers['Authorization'] = 'Bearer ' + os.environ['JEV_API_KEY']
                headers['User-Agent'] = client.headers.get('User-Agent') or 'node'
            elif session:
                headers['x-wb-session-id'] = session
            target = JEV_UPSTREAM if jev else self.pool
        request = urllib.request.Request(target, data=raw, headers=headers)
        response_raw = bytearray()
        response_encoding = ''
        started = time.perf_counter()
        sent_headers = False
        try:
            opener = self.jev_opener if (jev or opencode) else self.execution_opener
            try:
                response = opener.open(request, timeout=180)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                record['httpStatus'] = response.code
                response_encoding = response.headers.get('Content-Encoding', '')
                account = response.headers.get('x-wb-account')
                if account is not None:
                    with self.lock:
                        if account not in self.account_labels:
                            self.account_labels[account] = f'account-{len(self.account_labels) + 1}'
                        record['account'] = self.account_labels[account]
                client.send_response(response.code)
                connection_headers = tuple(name.strip().lower() for name in response.headers.get('Connection', '').split(','))
                for name, value in response.headers.items():
                    if name.lower() not in SKIPPED_HEADERS + connection_headers:
                        client.send_header(name, value)
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
            try:
                self.capture_usage(record, content_body(response_raw, response_encoding))
            except (ValueError, zlib.error):
                record['usageError'] = 'Unsupported or malformed content encoding'
            record['costUSD'] = (0.0 if jev else
                                 cost_usd(record.get('actualModel') or record.get('model'), usage_of(record)))
            if opencode and record['costUSD'] is not None:
                with self.lock:
                    self.spend += record['costUSD']
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
            message = item.get('message') if isinstance(item.get('message'), dict) else {}
            response = item.get('response') if isinstance(item.get('response'), dict) else {}
            if item.get('type') in ('message', 'message_start', 'message_delta'):
                record['usageProtocol'] = 'anthropic-messages'
            for source in (message, response, item):
                if isinstance(source.get('model'), str):
                    record['actualModel'] = source['model']
                usage = source.get('usage')
                if not isinstance(usage, dict):
                    continue
                merged = record.setdefault('usage', {})
                for key in ('prompt_tokens', 'input_tokens', 'completion_tokens', 'output_tokens',
                            'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens',
                            'cache_read_input_tokens', 'cache_creation_input_tokens'):
                    value = numeric(usage.get(key))
                    if value is not None:
                        merged[key] = value
                for key in ('prompt_tokens_details', 'input_tokens_details'):
                    details = usage.get(key)
                    value = numeric(details.get('cached_tokens')) if isinstance(details, dict) else None
                    if value is not None:
                        merged[key] = {'cached_tokens': value}
            # Recompute from the merged usage so a later event's field wins over an earlier derived token.
            record.update({key + 'Tokens': value
                           for key, value in usage_of({'usage': record.get('usage'),
                                                      'usageProtocol': record.get('usageProtocol')}).items()})

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
