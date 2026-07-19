#!/usr/bin/env python3
import json
import os
import sys


def send(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


for raw in sys.stdin:
    try:
        message = json.loads(raw)
    except json.JSONDecodeError:
        continue
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
        continue
    request_id = message.get("id")
    method = message.get("method")
    if request_id is None:
        continue
    if method == "initialize":
        params = message.get("params") or {}
        send({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "protocolVersion": params.get("protocolVersion", "2025-03-26"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "folderforge-sandbox-smoke", "version": "1.0.0"},
            },
        })
    elif method == "tools/list":
        send({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "tools": [{
                    "name": "inspect_boundary",
                    "description": "Return bounded container boundary evidence.",
                    "inputSchema": {"type": "object", "properties": {}},
                }]
            },
        })
    elif method == "tools/call":
        evidence = {
            "cwd": os.getcwd(),
            "allowedEnv": os.environ.get("SANDBOX_ALLOWED"),
            "undeclaredSecretVisible": bool(os.environ.get("SANDBOX_UNDECLARED_SECRET")),
            "uid": os.getuid() if hasattr(os, "getuid") else None,
        }
        send({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {"content": [{"type": "text", "text": json.dumps(evidence)}]},
        })
    elif method == "ping":
        send({"jsonrpc": "2.0", "id": request_id, "result": {}})
    else:
        send({
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": -32601, "message": "Method not found"},
        })
