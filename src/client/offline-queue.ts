/**
 * Offline call queue.
 *
 * Mutations issued while the transport is down (or that fail in a
 * retryable way) are held here keyed by `Idempotency-Key`. On
 * reconnect the queue is drained in FIFO order; each call is
 * resolved or rejected exactly once.
 *
 * Three backends:
 *
 *   - `'memory'` — an in-process array. Lost on page reload.
 *   - `'indexeddb'` — durable across reloads; keyed by Idempotency-
 *     Key. Falls back to memory if IndexedDB isn't available.
 *   - `'none'` — disabled. Calls reject immediately when offline.
 *
 * The backend is pluggable so unit tests can inject `fake-indexeddb`
 * without spinning a browser.
 */

export interface QueuedCall {
  readonly idempotencyKey: string;
  readonly className: string;
  readonly actorId: string;
  readonly method: string;
  readonly args: unknown;
  /** When the call was first enqueued (epoch ms). */
  readonly enqueuedAt: number;
}

export interface OfflineQueueBackend {
  enqueue(call: QueuedCall): Promise<void>;
  /** Return queued calls in insertion order. */
  list(): Promise<readonly QueuedCall[]>;
  remove(idempotencyKey: string): Promise<void>;
  /** Drop the entire queue (for tests / explicit reset). */
  clear(): Promise<void>;
}

/* ------------------------------------------------------------- Memory */

export class MemoryOfflineQueue implements OfflineQueueBackend {
  private entries: QueuedCall[] = [];
  async enqueue(call: QueuedCall): Promise<void> {
    this.entries.push(call);
  }
  async list(): Promise<readonly QueuedCall[]> {
    return [...this.entries];
  }
  async remove(idempotencyKey: string): Promise<void> {
    this.entries = this.entries.filter((e) => e.idempotencyKey !== idempotencyKey);
  }
  async clear(): Promise<void> {
    this.entries = [];
  }
}

/* ----------------------------------------------------------- Disabled */

export class NoopOfflineQueue implements OfflineQueueBackend {
  async enqueue(): Promise<void> {
    throw new Error('offline queue disabled');
  }
  async list(): Promise<readonly QueuedCall[]> {
    return [];
  }
  async remove(): Promise<void> {
    // no-op
  }
  async clear(): Promise<void> {
    // no-op
  }
}

/* ---------------------------------------------------------- IndexedDB */

const DB_NAME = 'actjs-client';
const STORE = 'offline-queue';
const DB_VERSION = 1;

/* Minimal IndexedDB type surface. The SDK ships without the DOM
 * lib because it runs in Node tests as well as browsers; these
 * interfaces describe only the methods we actually call.
 */
interface IDBRequest<T = unknown> {
  readonly result: T;
  readonly error: unknown;
  onsuccess: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onupgradeneeded?: ((ev: unknown) => void) | null;
}
interface IDBObjectStore {
  put(value: unknown): IDBRequest;
  getAll(): IDBRequest<unknown>;
  delete(key: string): IDBRequest;
  clear(): IDBRequest;
}
type IDBTransactionMode = 'readonly' | 'readwrite';
interface IDBDatabaseLike {
  readonly objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string, options?: { keyPath?: string }): IDBObjectStore;
  transaction(
    store: string,
    mode: IDBTransactionMode,
  ): { objectStore(name: string): IDBObjectStore };
}
interface IDBFactoryLike {
  open(name: string, version?: number): IDBRequest<IDBDatabaseLike>;
}

/**
 * IndexedDB-backed queue.
 *
 * Uses the platform-global `indexedDB`; tests inject
 * `fake-indexeddb/auto` to populate it under Node. If the global is
 * absent the constructor throws so callers can fall back to memory.
 */
export class IndexedDbOfflineQueue implements OfflineQueueBackend {
  private dbPromise: Promise<IDBDatabaseLike> | null = null;
  private readonly factory: IDBFactoryLike;

  constructor(factory?: IDBFactoryLike) {
    const f = factory ?? (globalThis as unknown as { indexedDB?: IDBFactoryLike }).indexedDB;
    if (!f) {
      throw new Error('no IndexedDB available — pass `factory` or use the memory backend');
    }
    this.factory = f;
  }

  private getDb(): Promise<IDBDatabaseLike> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise<IDBDatabaseLike>((resolve, reject) => {
      const req = this.factory.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (): void => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'idempotencyKey' });
        }
      };
      req.onsuccess = (): void => resolve(req.result);
      req.onerror = (): void => reject(req.error);
    });
    return this.dbPromise;
  }

  private async tx(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.getDb();
    return db.transaction(STORE, mode).objectStore(STORE);
  }

  async enqueue(call: QueuedCall): Promise<void> {
    const store = await this.tx('readwrite');
    await idbRequest(store.put(call));
  }

  async list(): Promise<readonly QueuedCall[]> {
    const store = await this.tx('readonly');
    const all = await idbRequest<unknown>(store.getAll());
    const arr = (all ?? []) as QueuedCall[];
    return [...arr].sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  }

  async remove(idempotencyKey: string): Promise<void> {
    const store = await this.tx('readwrite');
    await idbRequest(store.delete(idempotencyKey));
  }

  async clear(): Promise<void> {
    const store = await this.tx('readwrite');
    await idbRequest(store.clear());
  }
}

function idbRequest<T = void>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void => reject(req.error);
  });
}

/* ---------------------------------------------------------- Factory */

export type OfflineQueueMode = 'memory' | 'indexeddb' | 'none' | OfflineQueueBackend;

export function makeOfflineQueue(mode: OfflineQueueMode): OfflineQueueBackend {
  if (typeof mode !== 'string') return mode;
  if (mode === 'none') return new NoopOfflineQueue();
  if (mode === 'indexeddb') {
    try {
      return new IndexedDbOfflineQueue();
    } catch {
      // No platform IndexedDB — degrade gracefully.
      return new MemoryOfflineQueue();
    }
  }
  return new MemoryOfflineQueue();
}
