/**
 * World library: worlds are kept in IndexedDB so the planet survives a reload.
 * A record is a plain JSON snapshot of every subsystem plus enough metadata to
 * list, rename, duplicate and export it without loading the whole thing.
 */
import { SAVE } from '../core/config';

export interface WorldRecord {
  id: string;
  name: string;
  seed: string;
  /** In-game day the snapshot was taken on. */
  day: number;
  year: number;
  /** Real timestamp (ms) of the save, used for "while you were away". */
  savedAt: number;
  /** Population across all species, for the library cards. */
  population: number;
  species: number;
  /** Total simulated minutes, used for playtime readouts. */
  minutes: number;
  byteSize: number;
  thumbnail?: string;
  data: Record<string, unknown>;
}

const DB_NAME = 'living-planet';
const DB_VERSION = 1;
const STORE = 'worlds';
const LAST_KEY = 'living-planet:last';

export class WorldStore {
  private db: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);
    if (this.opening) return this.opening;
    this.opening = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is not available in this browser'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('savedAt', 'savedAt');
        }
      };
      request.onsuccess = () => {
        this.db = request.result;
        resolve(request.result);
      };
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    });
    return this.opening;
  }

  private async tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = run(transaction.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async list(): Promise<Omit<WorldRecord, 'data'>[]> {
    try {
      const all = (await this.tx('readonly', (s) => s.getAll() as IDBRequest<WorldRecord[]>)) ?? [];
      return all
        .map(({ data, ...meta }: WorldRecord) => {
          void data;
          return meta;
        })
        .sort((a, b) => b.savedAt - a.savedAt);
    } catch {
      return [];
    }
  }

  async save(record: WorldRecord): Promise<void> {
    await this.tx('readwrite', (s) => s.put(record));
  }

  async get(id: string): Promise<WorldRecord | null> {
    try {
      const record = await this.tx('readonly', (s) => s.get(id) as IDBRequest<WorldRecord | undefined>);
      return record ?? null;
    } catch {
      return null;
    }
  }

  async rename(id: string, name: string): Promise<void> {
    const record = await this.get(id);
    if (!record) return;
    record.name = name;
    await this.save(record);
  }

  async remove(id: string): Promise<void> {
    await this.tx('readwrite', (s) => s.delete(id));
  }

  async duplicate(id: string, name: string): Promise<WorldRecord | null> {
    const record = await this.get(id);
    if (!record) return null;
    const copy: WorldRecord = { ...record, id: newId(), name, savedAt: Date.now() };
    await this.save(copy);
    return copy;
  }

  /** Export as a downloadable JSON string. */
  static export(record: WorldRecord): string {
    return JSON.stringify({ format: 'living-planet-world', version: 1, ...record }, null, 0);
  }

  /** Parse an exported world; throws with a readable message on bad input. */
  static parse(text: string): WorldRecord {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('That file is not valid JSON.');
    }
    const r = parsed as Partial<WorldRecord> & { format?: string };
    if (!r || r.format !== 'living-planet-world' || !r.data) {
      throw new Error('That file is not a Living Planet world.');
    }
    return {
      id: newId(),
      name: r.name ?? 'Imported world',
      seed: r.seed ?? 'imported',
      day: r.day ?? 1,
      year: r.year ?? 1,
      savedAt: Date.now(),
      population: r.population ?? 0,
      species: r.species ?? 0,
      minutes: r.minutes ?? 0,
      byteSize: r.byteSize ?? JSON.stringify(r.data).length,
      thumbnail: r.thumbnail,
      data: r.data as Record<string, unknown>,
    };
  }

  static newId(): string {
    return newId();
  }

  static estimateSize(data: unknown): number {
    try {
      return JSON.stringify(data).length;
    } catch {
      return 0;
    }
  }

  /** Autosave interval in real seconds, from the shared config. */
  get autosaveSeconds(): number {
    return SAVE.autosaveSeconds;
  }

  get offlineCapDays(): number {
    return SAVE.offlineCapDays;
  }
}

function newId(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes)
    .map((b) => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 12);
}

/** Which world should be reopened on the next visit. */
export const lastWorld = {
  get(): string | null {
    try {
      return localStorage.getItem(LAST_KEY);
    } catch {
      return null;
    }
  },
  set(id: string | null): void {
    try {
      if (id) localStorage.setItem(LAST_KEY, id);
      else localStorage.removeItem(LAST_KEY);
    } catch {
      /* private mode: not fatal */
    }
  },
};
