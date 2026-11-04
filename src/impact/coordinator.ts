import { createHash } from "node:crypto";

/** Internal interfaces: capture backends must establish complete observation before enumeration. */
interface CaptureBackend {
  acquire(): Promise<{ strategy: "observed" | "immutable"; identity: string }>;
  observe(): Promise<{ covered: boolean }>;
  enumerate(): Promise<string[]>;
  read(path: string): Promise<string>;
  seal(): Promise<{ covered: boolean; events: unknown[] }>;
  cleanup(): Promise<void>;
}
export async function captureWorktree({ backend, maxAttempts = 1 }: { backend: CaptureBackend; maxAttempts?: number }) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const snapshot = await backend.acquire();
      if (snapshot.strategy !== "immutable" && snapshot.strategy !== "observed") continue;
      if (snapshot.strategy === "observed" && !(await backend.observe()).covered) continue;
      const files: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const path of (await backend.enumerate()).sort()) {
        const value = await backend.read(path);
        if (typeof value !== "string") throw new Error("capture read failed");
        files[path] = value;
      }
      const sealed = await backend.seal();
      if (snapshot.strategy === "observed" && (!sealed.covered || sealed.events.length !== 0)) continue;
      const hash = createHash("sha256");
      for (const path of Object.keys(files)) hash.update(JSON.stringify([path, files[path]]));
      return { status: "captured" as const, files: { ...files }, fingerprint: hash.digest("hex"), snapshotIdentity: snapshot.identity };
    } catch {
      // Any loss of observation, enumeration or read invalidates this attempt.
    } finally { await backend.cleanup(); }
  }
  return { status: "unavailable" as const };
}

type CacheIdentity = { snapshot: string; mode: string; policy: string; version: string };
type CacheEntry = { identity: CacheIdentity; value: unknown };
interface CacheStore { read(): Promise<CacheEntry | null>; refresh(identity: CacheIdentity): Promise<CacheEntry>; publish(entry: CacheEntry): Promise<void> }
function same(a: CacheIdentity | undefined, b: CacheIdentity): boolean {
  return !!a && a.snapshot === b.snapshot && a.mode === b.mode && a.policy === b.policy && a.version === b.version;
}
export async function loadConservativeGraph({ cache, identity }: { cache: CacheStore; identity: CacheIdentity }) {
  try {
    if (identity.mode !== "conservative") throw new Error("not conservative");
    const entry = await cache.read();
    if (entry && same(entry.identity, identity)) return { status: "current" as const, ...entry };
    const fresh = await cache.refresh(identity);
    if (!fresh || !same(fresh.identity, identity)) throw new Error("refresh identity mismatch");
    await cache.publish(fresh);
    return { status: "current" as const, ...fresh };
  } catch { return { status: "unavailable" as const }; }
}
