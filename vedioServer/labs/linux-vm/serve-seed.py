"""仅在回环地址提供本轮只读NoCloud种子及固定制品，不支持上传。"""

import argparse
import functools
import http.server
import pathlib
import socketserver


class SeedHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path not in {"/user-data", "/meta-data", "/vendor-data", "/network-config",
                             "/iggy-server", "/config.toml"}:
            self.send_error(404)
            return
        super().do_GET()

    def do_HEAD(self):
        self.send_error(405)

    def log_message(self, message, *args):
        print(message % args, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="提供本轮只读虚拟机种子")
    parser.add_argument("directory", type=pathlib.Path)
    parser.add_argument("port", type=int)
    arguments = parser.parse_args()
    root = arguments.directory.resolve(strict=True)
    if root.drive.upper() != "O:" or not 1024 <= arguments.port <= 65535:
        raise SystemExit("种子目录须位于O盘，端口须为1024至65535")
    handler = functools.partial(SeedHandler, directory=str(root))
    with socketserver.TCPServer(("127.0.0.1", arguments.port), handler) as server:
        server.timeout = 1
        print("种子服务已在回环就绪", flush=True)
        server.serve_forever()
