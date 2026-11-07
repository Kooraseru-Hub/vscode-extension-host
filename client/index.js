'use strict';

const { RpcPeer } = require('../src/rpc-peer');
const { readDiscovery } = require('../src/discovery');
const { AsyncLocalStorage } = require('node:async_hooks');

const REF = Symbol('workbench-bridge.remote-ref');

/** A stable handle to an object or function in the remote VS Code process. */
class RemoteRef {
  constructor(id, client) {
    Object.defineProperty(this, REF, { value: true });
    this.id = id;
    this._client = client;
  }
  toJSON() { return { $type: 'ref', id: this.id }; }
}

function encode(value, client) {
  if (value === undefined) return { $type: 'undefined' };
  if (typeof value === 'bigint') return { $type: 'bigint', value: String(value) };
  if (typeof value === 'number' && !Number.isFinite(value)) return { $type: 'number', value: Number.isNaN(value) ? 'NaN' : value > 0 ? '+Infinity' : '-Infinity' };
  if (typeof value === 'function') {
    const id = client._registerCallback(value);
    return { $type: 'callback', id };
  }
  if (value && value[REF]) {
    if (value._client !== client) throw new TypeError('Remote references belong to another client');
    return { $type: 'ref', id: value.id };
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { $type: 'bytes', data: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return { $type: 'array', items: value.map(item => encode(item, client)) };
  if (value && typeof value === 'object') return { $type: 'object', entries: Object.entries(value).map(([key, item]) => [key, encode(item, client)]) };
  return value;
}

function decode(value, client) {
  if (!value || typeof value !== 'object' || !value.$type) return value;
  switch (value.$type) {
    case 'undefined': return undefined;
    case 'bigint': return BigInt(value.value);
    case 'number': return value.value === 'NaN' ? NaN : value.value === '+Infinity' ? Infinity : -Infinity;
    case 'bytes': return Buffer.from(value.data, 'base64');
    case 'array': return value.items.map(item => decode(item, client));
    case 'object': {
      const out = {};
      for (const [key, item] of value.entries) out[key] = decode(item, client);
      return out;
    }
    case 'ref': return client._ref(value.id);
    case 'callback': return client._callbacks.get(value.id);
    default: return value;
  }
}

function adaptSocket(raw) {
  if (typeof raw.on === 'function' && typeof raw.removeListener === 'function') return raw;
  const listeners = new Map();
  const native = {
    get readyState() { return raw.readyState; },
    send: data => raw.send(data),
    close: (...args) => raw.close(...args),
    on(name, listener) {
      let set = listeners.get(name);
      if (!set) {
        set = new Map();
        listeners.set(name, set);
        raw.addEventListener(name, event => {
          const args = name === 'message' ? [event.data] : name === 'close' ? [event.code, event.reason] : name === 'error' ? [event.error || event.message] : [];
          for (const fn of [...set.values()]) fn(...args);
        });
      }
      set.set(listener, listener);
      return native;
    },
    once(name, listener) {
      const wrapped = (...args) => { native.removeListener(name, wrapped); listener(...args); };
      native.on(name, wrapped);
      return native;
    },
    removeListener(name, listener) { listeners.get(name)?.delete(listener); return native; },
  };
  return native;
}

function createSocket(endpoint, options) {
  if (options.socket) return adaptSocket(options.socket);
  if (typeof globalThis.WebSocket === 'function' && !options.websocketOptions) return adaptSocket(new globalThis.WebSocket(endpoint));
  const WebSocket = require('ws');
  return adaptSocket(new WebSocket(endpoint, options.websocketOptions));
}

function waitUntilOpen(socket) {
  if (socket.readyState === 1) return Promise.resolve();
  if (socket.readyState >= 2) return Promise.reject(new Error('WebSocket connection is closed'));
  return new Promise((resolve, reject) => {
    const opened = () => { cleanup(); resolve(); };
    const failed = error => { cleanup(); reject(error instanceof Error ? error : new Error('WebSocket connection failed')); };
    const closed = () => failed(new Error('WebSocket closed before connecting'));
    const cleanup = () => { socket.removeListener('open', opened); socket.removeListener('error', failed); socket.removeListener('close', closed); };
    socket.on('open', opened);
    socket.on('error', failed);
    socket.on('close', closed);
  });
}

function encodeTarget(target, client) {
  if (target instanceof RemoteRef) {
    if (target._client !== client) throw new TypeError('Remote references belong to another client');
    return { $type: 'ref', id: target.id };
  }
  return target;
}

class WorkbenchClient {
  constructor(socket, descriptor, workspace) {
    this.socket = socket;
    this.descriptor = descriptor;
    this.workspace = workspace || descriptor.workspace;
    this._refs = new Map();
    this._callbacks = new Map();
    this._incomingCallbacks = new Map();
    this._callbackStorage = new AsyncLocalStorage();
    this._subscriptions = new Map();
    this._subscriptionCallbacks = new Map();
    this._nextCallback = 1;
    this._nextSubscription = 1;
    this._peer = new RpcPeer(socket, {
      onRequest: (method, params, id) => this._onRequest(method, params, id),
      onNotification: (method, params) => this._onNotification(method, params),
    });
    this.closed = this._peer.closed;
    this.closed.then(() => this._clearCallbacks());
  }

  static async connect(options = {}) {
    let descriptor;
    if (options.endpoint && options.token) {
      descriptor = { endpoint: options.endpoint, token: options.token, workspace: options.workspace };
    } else {
      descriptor = await readDiscovery({ workspace: options.workspace, sessionId: options.sessionId,
        discoveryRoot: options.discoveryRoot, sessionFile: options.sessionFile });
    }
    if (!descriptor || !descriptor.endpoint || !descriptor.token) throw new Error('A bridge endpoint and token are required');
    const socket = createSocket(descriptor.endpoint, options);
    await waitUntilOpen(socket);
    const client = new WorkbenchClient(socket, descriptor, options.workspace);
    try {
      await client._peer.request('connect', { token: descriptor.token, workspace: client.workspace });
    } catch (error) {
      client.close();
      throw error;
    }
    return client;
  }

  _ref(id) {
    if (!this._refs.has(id)) this._refs.set(id, new RemoteRef(id, this));
    return this._refs.get(id);
  }
  _registerCallback(fn) {
    const id = String(this._nextCallback++);
    this._callbacks.set(id, fn);
    return id;
  }
  async _onRequest(method, params = {}, requestId) {
    if (method !== 'callback') throw new Error(`Unsupported server request: ${method}`);
    const fn = this._callbacks.get(params.id);
    if (!fn) throw new Error(`Unknown callback: ${params.id}`);
    const controller = new AbortController();
    const requestKey = String(requestId);
    this._incomingCallbacks.set(requestKey, controller);
    const args = (params.args || []).map(arg => decode(arg, this));
    try {
      return await this._callbackStorage.run(Object.freeze({ signal: controller.signal }), async () => encode(await fn(...args), this));
    } finally {
      this._incomingCallbacks.delete(requestKey);
    }
  }
  _onNotification(method, params = {}) {
    if (method === '$/cancelRequest') {
      this._incomingCallbacks.get(String(params.id))?.abort();
      return;
    }
    if (method !== 'event') return;
    const listeners = this._subscriptions.get(params.subscription);
    if (listeners) for (const listener of [...listeners]) listener(decode(params.value, this));
  }

  get(params, options) { return this._request('get', { ...params, target: encodeTarget(params.target, this) }, options); }
  set(params, options) { return this._request('set', { ...params, target: encodeTarget(params.target, this), value: encode(params.value, this) }, options); }
  call(params, options) { return this._request('call', { ...params, target: encodeTarget(params.target, this), args: (params.args || []).map(arg => encode(arg, this)) }, options); }
  construct(params, options) { return this._request('construct', { ...params, target: encodeTarget(params.target, this), args: (params.args || []).map(arg => encode(arg, this)), owned: !!params.owned }, options); }
  loadModule(params, options) { return this._request('loadModule', params, options); }
  snapshot(params, options) { return this._request('snapshot', { ...params, target: encodeTarget(params.target, this) }, options); }
  release(params, options) { return this._request('release', { ...params, target: encodeTarget(params.target, this) }, options); }
  dispose(params, options) { return this._request('dispose', { ...params, target: encodeTarget(params.target, this) }, options); }

  async subscribe(params, options) {
    if (!params || typeof params.callback !== 'function') throw new TypeError('subscribe requires { target, path, callback }');
    const callback = encode(params.callback, this);
    try {
      const ref = await this._request('subscribe', { ...params, target: encodeTarget(params.target, this), callback }, options);
      this._subscriptionCallbacks.set(ref.id, callback.id);
      return ref;
    } catch (error) {
      this._callbacks.delete(callback.id);
      throw error;
    }
  }
  async unsubscribe(params, options) {
    const ref = params.subscription;
    const result = await this._request('unsubscribe', { ...params, subscription: encodeTarget(ref, this) }, options);
    if (ref && this._subscriptionCallbacks.has(ref.id)) {
      this._callbacks.delete(this._subscriptionCallbacks.get(ref.id));
      this._subscriptionCallbacks.delete(ref.id);
    }
    return result;
  }

  async _request(method, params, options = {}) {
    const result = await this._peer.request(method, params, options);
    return decode(result, this);
  }
  onClose(listener) {
    return this._peer.onClose(listener);
  }
  /** Current callback request context, or undefined outside a remote callback. */
  get callbackContext() { return this._callbackStorage.getStore(); }
  _clearCallbacks() {
    for (const controller of this._incomingCallbacks.values()) controller.abort();
    this._incomingCallbacks.clear();
    this._subscriptions.clear();
    this._subscriptionCallbacks.clear();
    this._callbacks.clear();
  }
  close() {
    if (this._peer) this._peer.close();
    if (this.socket && this.socket.readyState < 2) this.socket.close();
    this._clearCallbacks();
  }
}

module.exports = { connect: WorkbenchClient.connect, WorkbenchClient, RemoteRef, encode, decode };
