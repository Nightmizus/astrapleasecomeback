from __future__ import annotations

import os
import socket
import sys
import threading
import webbrowser

sys.dont_write_bytecode = True

from app import app  # noqa: E402


def bind_host() -> str:
    return os.environ.get("MODELTRACE_HOST") or "0.0.0.0"


def lan_addresses(port: int) -> list[str]:
    addresses = ["127.0.0.1"]
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            address = info[4][0]
            if address not in addresses:
                addresses.append(address)
    except OSError:
        pass
    return [f"http://{address}:{port}" for address in addresses]


if __name__ == "__main__":
    port = int(os.environ.get("MODELTRACE_PORT") or 7860)
    host = bind_host()
    if os.environ.get("DISPLAY") or sys.platform == "darwin":
        threading.Timer(1.0, lambda: webbrowser.open(f"http://127.0.0.1:{port}")).start()
    print(f"ModelTrace 监听 {host}:{port}")
    for url in lan_addresses(port):
        print(f"  可访问：{url}")
    app.run(host=host, port=port, debug=False)
