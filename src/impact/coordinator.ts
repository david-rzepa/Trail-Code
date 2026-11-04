/** Internal, injected Git snapshot and conservative cache boundaries. */
type TreeEntry = { path: string; mode: string; oid: string };
interface GitReader {
  resolve(ref: string): Promise<{ commit: string; tree: string }>;
  readTree(tree: string): Promise<TreeEntry[]>;
  readBlob(oid: string): Promise<unknown>;
}
interface TreeMaterializer {
  writeTree(entries: Array<TreeEntry & { bytes: unknown }>): Promise<unknown>;
  cleanup(): Promise<void>;
}
export async function readCommittedSnapshot({git, materializer, ref}: {git: GitReader; materializer: TreeMaterializer; ref: string}) {
  let materializing = false;
  try {
    const {commit, tree} = await git.resolve(ref);
    if (!commit || !tree) throw new Error("missing immutable identity");
    const records = await git.readTree(tree);
    const entries = [];
    for (const entry of records) entries.push({...entry, bytes: await git.readBlob(entry.oid)});
    materializing = true;
    const value = await materializer.writeTree(entries);
    return {status: "captured" as const, commit, tree, fingerprint: `git-tree:${tree}`, value};
  } catch { return {status: "unavailable" as const}; }
  finally { if (materializing) await materializer.cleanup(); }
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
