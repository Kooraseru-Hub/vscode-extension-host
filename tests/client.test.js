'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { connect } = require('../client');

test('client authenticates, calls remote members, decodes identities, and handles callbacks', async t => {
  const server = new WebSocket.Server({ port: 0, host: '127.0.0.1' });
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  t.after(() => server.close());
  const seen = [];

  server.on('connection', socket => {
    const refs = new Map([['1', { count: 0 }]]);
    socket.on('message', async raw => {
      const request = JSON.parse(raw.toString());
      seen.push(request);
      const respond = result => socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
      try {
        if (request.method === 'connect') return respond({ ok: true });
        if (request.method === 'call' && request.params.path[0] === 'increment') {
          refs.get('1').count += 1;
          return respond({ $type: 'ref', id: '1' });
        }
        if (request.method === 'snapshot') return respond({ $type: 'object', entries: [['count', refs.get('1').count], ['nil', { $type: 'undefined' }]] });
        if (request.method === 'subscribe') {
          const callback = request.params.callback;
          socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'callback', id: 900, params: { id: callback.id, args: ['change'] } }));
          return respond({ $type: 'ref', id: '2' });
        }
        if (request.method === 'callback') return respond(null);
        respond(null);
      } catch (error) {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: error.message } }));
      }
    });
  });

  const client = await connect({ endpoint: `ws://127.0.0.1:${port}`, token: 'test-secret', workspace: 'workspace', socket: await openClient(`ws://127.0.0.1:${port}`) });
  t.after(() => client.close());
  const returned = await client.call({ target: 'vscode', path: ['increment'] });
  assert.equal(returned.id, '1');
  assert.equal(await client.call({ target: 'vscode', path: ['increment'] }), returned);
  assert.deepEqual(await client.snapshot({ target: returned, path: [] }), { count: 2, nil: undefined });

  let event;
  const subscription = await client.subscribe({ target: returned, path: ['onDidChange'], callback: value => { event = value; } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(event, 'change');
  await client.unsubscribe({ subscription });
  assert.deepEqual(seen[0].params, { token: 'test-secret', workspace: 'workspace' });
});

function openClient(url) {
  const socket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

test('SDK interoperates with the actual bridge server, validates ref ownership, and closes cleanly', async t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { startBridgeServer } = require('../src/bridge-server');
  const { readDiscovery } = require('../src/discovery');
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-client-'));
  t.after(() => fs.rmSync(workspacePath, { recursive: true, force: true }));
  const state = { shown: 0, disposed: 0, listeners: new Set() };
  const item = {
    text: '',
    show() { state.shown++; },
    onDidChange(listener) { state.listeners.add(listener); return { dispose() { state.listeners.delete(listener); } }; },
    dispose() { state.disposed++; },
  };
  const vscode = {
    workspace: { isTrusted: true },
    window: {
      createStatusBarItem: () => item,
      echoCallback: callback => callback({ nested: true }),
      awaitCallback: callback => callback(),
    },
  };
  const extensionContext = { subscriptions: [] };
  const workspaceFolder = { name: 'test', uri: { fsPath: workspacePath } };
  const server = await startBridgeServer({ vscode, extensionContext, workspaceFolder });
  t.after(() => server.dispose());
  const activeClient = await connect({ sessionFile: server.sessionFile });
  t.after(() => activeClient.close());
  const remote = await activeClient.call({ target: 'vscode', path: ['window', 'createStatusBarItem'], args: [] });
  await activeClient.set({ target: remote, path: ['text'], value: 'External client' });
  await activeClient.set({ target: remote, path: ['payload'], value: new Uint8Array([0, 1, 255]) });
  await activeClient.call({ target: remote, path: ['show'], args: [] });
  const echoed = await activeClient.call({ target: 'vscode', path: ['window', 'echoCallback'], args: [value => ({ echoed: value })] });
  assert.equal(echoed.constructor.name, 'RemoteRef');
  assert.deepEqual(await activeClient.snapshot({ target: echoed, path: [] }), { echoed: { nested: true } });
  assert.equal(await activeClient.get({ target: remote, path: ['text'] }), 'External client');
  assert.deepEqual(await activeClient.get({ target: remote, path: ['payload'] }), Buffer.from([0, 1, 255]));
  assert.equal(state.shown, 1);
  let started;
  const callbackStarted = new Promise(resolve => { started = resolve; });
  let aborted;
  const callbackAborted = new Promise(resolve => { aborted = resolve; });
  const cancelController = new AbortController();
  const cancelledCall = activeClient.call({ target: 'vscode', path: ['window', 'awaitCallback'], args: [async () => {
    started();
    const signal = activeClient.callbackContext.signal;
    await new Promise(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true }));
    aborted(signal.aborted);
    return 'cancelled';
  }] }, { signal: cancelController.signal });
  await callbackStarted;
  cancelController.abort();
  await assert.rejects(cancelledCall, /cancel/i);
  assert.equal(await callbackAborted, true);
  let eventValue;
  const subscription = await activeClient.subscribe({ target: remote, path: ['onDidChange'], callback: value => { eventValue = value; } });
  state.listeners.values().next().value('changed');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(eventValue, 'changed');
  await activeClient.unsubscribe({ subscription });
  assert.equal(state.listeners.size, 0);
  const secondClient = await connect({ sessionFile: server.sessionFile });
  t.after(() => secondClient.close());
  assert.throws(() => secondClient.get({ target: remote, path: ['text'] }), /another client/);
  assert.equal(await activeClient.get({ target: remote, path: ['text'] }), 'External client');
  await activeClient.dispose({ target: remote });
  assert.equal(state.disposed, 1);
  await activeClient.close();
  await activeClient.closed;

  const secondServer = await startBridgeServer({ vscode, extensionContext, workspaceFolder });
  t.after(() => secondServer.dispose());
  await assert.rejects(() => connect({ workspace: workspacePath }), /Multiple VS Code sessions/);
  const descriptor = readDiscovery({ sessionFile: server.sessionFile });
  await assert.rejects(() => connect({ endpoint: descriptor.endpoint, token: 'incorrect-token', workspace: descriptor.workspace }), /authentication/i);
});
