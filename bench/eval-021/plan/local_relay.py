"""Expose observer ports to an internal Docker network only."""
import select
import socket
import socketserver
import threading


class LocalRelay:
    def __init__(self, host, port):
        target = port

        class Handler(socketserver.BaseRequestHandler):
            def handle(self):
                with socket.create_connection(('127.0.0.1', target), timeout=10) as upstream:
                    upstream.settimeout(None)
                    peers = [self.request, upstream]
                    while True:
                        ready, _, _ = select.select(peers, [], [], 240)
                        if not ready:
                            return
                        for source in ready:
                            data = source.recv(65536)
                            if not data:
                                return
                            (upstream if source is self.request else self.request).sendall(data)

        class Server(socketserver.ThreadingTCPServer):
            allow_reuse_address = True
            daemon_threads = True

        self.server = Server((host, port), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
