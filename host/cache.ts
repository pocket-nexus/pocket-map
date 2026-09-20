import { busy, notFound, tooLarge, upstream } from "../shared/failure.ts";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
export type NetworkFetch = (url: string | URL | Request, options?: RequestInit) => Promise<Response>;

/** Host-only HTTP cache. Completed tiles persist across provider reconnections;
 * in-flight requests deduplicate, with bounded bodies and conditional expiry. */
export class HttpCache {
  private db: Database;
  private pending = new Map<string, Promise<Uint8Array>>();
  private running = 0;
  hits = 0; downloads = 0;
  constructor(path: string, private network: NetworkFetch = fetch, private maxEntries = 2048) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS http (url TEXT PRIMARY KEY, bytes BLOB NOT NULL, expires INTEGER NOT NULL, etag TEXT, modified TEXT, touched INTEGER NOT NULL)");
  }
  get(url: string, options: { maxBytes: number; ttl: number; signal?: AbortSignal }): Promise<Uint8Array> {
    const existing = this.pending.get(url); if (existing) return existing;
    if (this.running >= 4) return Promise.reject(busy("Host request budget exhausted"));
    this.running++;
    const request = this.read(url, options).finally(() => { this.pending.delete(url); this.running--; });
    this.pending.set(url, request); return request;
  }
  private async read(url: string, options: { maxBytes: number; ttl: number; signal?: AbortSignal }) {
    const row = this.db.query("SELECT * FROM http WHERE url=?").get(url) as { bytes: Uint8Array; expires: number; etag: string; modified: string } | null;
    const now = Date.now();
    if (row && row.expires > now && row.bytes.byteLength <= options.maxBytes) {
      this.hits++; this.db.query("UPDATE http SET touched=? WHERE url=?").run(now, url); return row.bytes;
    }
    const headers: Record<string, string> = { "User-Agent": "PocketMap/0.1 (+https://github.com/pocket-stack/pocket-map)", "Accept": "application/vnd.mapbox-vector-tile,application/x-protobuf,image/png,application/json" };
    if (row?.etag) headers["If-None-Match"] = row.etag;
    if (row?.modified) headers["If-Modified-Since"] = row.modified;
    // Bun's redirect:error rejects 304 as well. Manual mode preserves cache
    // revalidation; the status checks below still reject actual redirects.
    const response = await this.network(url, { headers, redirect: "manual", signal: options.signal ?? AbortSignal.timeout(6500) });
    const cacheControl = response.headers.get("cache-control") ?? "";
    const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl);
    const expiresAt = Date.parse(response.headers.get("expires") ?? "");
    const age = Number(response.headers.get("age") ?? 0) || 0;
    const ttl = maxAge ? Math.max(0, Number(maxAge[1]) - age) * 1000 : Number.isFinite(expiresAt) ? Math.max(0, expiresAt - now) : options.ttl;
    let bytes: Uint8Array;
    if (response.status === 304 && row) bytes = row.bytes;
    else {
      if (!response.ok) throw (response.status === 404 ? notFound(`Map service returned HTTP ${response.status}`) : upstream(`Map service returned HTTP ${response.status}`));
      if (Number(response.headers.get("content-length") ?? 0) > options.maxBytes) { await response.body?.cancel(); throw tooLarge("Map response exceeds budget"); }
      const reader = response.body?.getReader(); if (!reader) throw upstream("Empty map response");
      const parts: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > options.maxBytes) { await reader.cancel(); throw tooLarge("Map response exceeds budget"); }
          parts.push(part.value);
        }
      } finally { reader.releaseLock(); }
      bytes = new Uint8Array(size); let at = 0; for (const part of parts) { bytes.set(part, at); at += part.length; }
      this.downloads++;
    }
    if (/no-store/i.test(cacheControl)) this.db.query("DELETE FROM http WHERE url=?").run(url);
    else {
      this.db.query("INSERT OR REPLACE INTO http VALUES (?,?,?,?,?,?)").run(url, bytes, now + (/no-cache/i.test(cacheControl) ? 0 : ttl), response.headers.get("etag") ?? row?.etag ?? null, response.headers.get("last-modified") ?? row?.modified ?? null, now);
      this.db.query("DELETE FROM http WHERE url IN (SELECT url FROM http ORDER BY touched DESC, url LIMIT -1 OFFSET ?)").run(this.maxEntries);
    }
    return bytes;
  }
  expires(url: string) { return (this.db.query("SELECT expires FROM http WHERE url=?").get(url) as { expires: number } | null)?.expires ?? 0; }
  close() { this.db.close(); }
}
