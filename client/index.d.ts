export interface ConnectOptions {
  /** Select one discovered session. */
  sessionId?: string;
  workspace?: string;
  discoveryRoot?: string;
  sessionFile?: string;
  /** Connect directly instead of reading a discovery file. */
  endpoint?: string;
  token?: string;
  /** Advanced: provide an already-open ws-compatible WebSocket. */
  socket?: object;
  websocketOptions?: Record<string, unknown>;
}

export type RemoteTarget = 'vscode' | 'context' | RemoteRef;
export interface RpcOptions { signal?: AbortSignal; }
export interface TargetPath { target: RemoteTarget; path: string[]; }
export interface CallbackContext { readonly signal: AbortSignal; }

/** Async RPC client. Remote members are explicitly accessed through these methods. */
export class WorkbenchClient {
  readonly descriptor: { endpoint: string; token: string; workspace?: string; [key: string]: unknown };
  readonly workspace?: string;
  readonly closed: Promise<void>;
  static connect(options?: ConnectOptions): Promise<WorkbenchClient>;
  get(params: TargetPath, options?: RpcOptions): Promise<unknown>;
  set(params: TargetPath & { value: unknown }, options?: RpcOptions): Promise<unknown>;
  call(params: TargetPath & { args?: unknown[]; owned?: boolean }, options?: RpcOptions): Promise<unknown>;
  construct(params: TargetPath & { args?: unknown[]; owned?: boolean }, options?: RpcOptions): Promise<RemoteRef>;
  subscribe(params: TargetPath & { callback: (...args: unknown[]) => unknown }, options?: RpcOptions): Promise<RemoteRef>;
  unsubscribe(params: { subscription: RemoteRef }, options?: RpcOptions): Promise<unknown>;
  loadModule(params: { path: string }, options?: RpcOptions): Promise<RemoteRef>;
  /** Snapshot plain values; nested remote references remain RemoteRef handles. */
  snapshot(params: { target: RemoteTarget; path?: string[] }, options?: RpcOptions): Promise<unknown>;
  release(params: { target: RemoteRef }, options?: RpcOptions): Promise<unknown>;
  dispose(params: { target: RemoteRef }, options?: RpcOptions): Promise<unknown>;
  onClose(listener: (...args: unknown[]) => void): { dispose(): void };
  /** Read the cancellable signal for the current callback without changing native callback arguments. */
  readonly callbackContext: CallbackContext | undefined;
  close(): void;
}

export class RemoteRef { readonly id: string; toJSON(): { $type: 'ref'; id: string }; }
export function connect(options?: ConnectOptions): Promise<WorkbenchClient>;
export function encode(value: unknown, client: WorkbenchClient): unknown;
export function decode(value: unknown, client: WorkbenchClient): unknown;
