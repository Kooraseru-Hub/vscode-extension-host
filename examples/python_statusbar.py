"""Run with: python -m pip install websockets && python examples/python_statusbar.py"""
import argparse
import asyncio
import json
import os
from pathlib import Path

import websockets


def session_path():
    parser = argparse.ArgumentParser()
    parser.add_argument('--session', help='Path to the bridge session descriptor JSON')
    parser.add_argument('--once', action='store_true', help='Dispose the item immediately without waiting for input')
    args = parser.parse_args()
    path = args.session or os.environ.get('WORKBENCH_BRIDGE_SESSION')
    if not path:
        raise SystemExit('Set WORKBENCH_BRIDGE_SESSION or pass --session <descriptor.json>')
    return Path(path), args.once


def encode(value):
    if isinstance(value, dict):
        return {'$type': 'object', 'entries': [[k, encode(v)] for k, v in value.items()]}
    if isinstance(value, list):
        return {'$type': 'array', 'items': [encode(v) for v in value]}
    return value


async def main():
    descriptor_path, once = session_path()
    descriptor = json.loads(descriptor_path.read_text(encoding='utf-8'))
    async with websockets.connect(descriptor['endpoint']) as socket:
        next_id = 1

        async def rpc(method, params):
            nonlocal next_id
            ident = next_id
            next_id += 1
            await socket.send(json.dumps({'jsonrpc': '2.0', 'id': ident, 'method': method, 'params': params}))
            while True:
                message = json.loads(await socket.recv())
                if message.get('id') != ident:
                    continue
                if 'error' in message:
                    raise RuntimeError(message['error'])
                return message.get('result')

        await rpc('connect', {'token': descriptor['token'], 'workspace': descriptor.get('workspace')})
        item = await rpc('call', {'target': 'vscode', 'path': ['window', 'createStatusBarItem'], 'args': ['bridge.external.python', 1, 100], 'owned': True})
        await rpc('set', {'target': item, 'path': ['text'], 'value': encode('$(check) Connected from Python')})
        await rpc('call', {'target': item, 'path': ['show'], 'args': []})
        print('Status bar item created.' if once else 'Status bar item created. Press Enter here to dispose it.')
        if not once:
            await asyncio.to_thread(input)
        await rpc('dispose', {'target': item})
        print('PASS: status bar item created, shown, and disposed')


if __name__ == '__main__':
    asyncio.run(main())
