import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { State } from './types';

/**
 * Durable storage in a single SQLite file (WAL mode). The engine state is saved every few seconds and
 * immediately after anything that involves real money; every real-money event is also appended to an
 * audit table that is never rewritten.
 */
export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, t REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS live_events (id INTEGER PRIMARY KEY AUTOINCREMENT, t REAL NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
    `);
  }

  /**
   * Single-instance lock: two engines on the same data would place duplicate real orders. The holder
   * refreshes it on every save; a lock older than 30 s is considered abandoned (crashed process).
   */
  acquireLock(owner: string, now = Date.now() / 1000): { ok: true } | { ok: false; holder: string; age: number } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT v, t FROM kv WHERE k = ?').get('lock') as { v: string; t: number } | undefined;
      if (row && row.v !== owner && now - row.t < 30) {
        this.db.exec('ROLLBACK');
        return { ok: false, holder: row.v, age: Math.round(now - row.t) };
      }
      this.db.prepare('INSERT INTO kv (k, v, t) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, t = excluded.t').run('lock', owner, now);
      this.db.exec('COMMIT');
      return { ok: true };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  refreshLock(owner: string): void {
    this.db.prepare('UPDATE kv SET t = ? WHERE k = ? AND v = ?').run(Date.now() / 1000, 'lock', owner);
  }

  releaseLock(owner: string): void {
    this.db.prepare('DELETE FROM kv WHERE k = ? AND v = ?').run('lock', owner);
  }

  loadState(): State | null {
    const row = this.db.prepare('SELECT v FROM kv WHERE k = ?').get('state') as { v: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.v) as State;
    } catch {
      return null;
    }
  }

  saveState(state: State): void {
    this.db.prepare('INSERT INTO kv (k, v, t) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, t = excluded.t').run('state', JSON.stringify(state), Date.now() / 1000);
  }

  /** Append-only audit trail of real-money events (orders placed, fills, cancels, settlements). */
  audit(kind: string, data: unknown): void {
    this.db.prepare('INSERT INTO live_events (t, kind, data) VALUES (?, ?, ?)').run(Date.now() / 1000, kind, JSON.stringify(data));
  }

  recentAudit(limit = 50): { t: number; kind: string; data: unknown }[] {
    const rows = this.db.prepare('SELECT t, kind, data FROM live_events ORDER BY id DESC LIMIT ?').all(limit) as { t: number; kind: string; data: string }[];
    return rows.map((r) => ({ t: r.t, kind: r.kind, data: JSON.parse(r.data) }));
  }

  close(): void {
    this.db.close();
  }
}
