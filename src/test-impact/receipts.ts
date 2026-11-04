import { constants, closeSync, fstatSync, lstatSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface Receipt {
  version: 1;
  id: string;
  commit: string;
  tree: string;
  context: string;
  profile: string;
  predecessor: string | null;
  stable_inputs_assumed: true;
}

const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const filename = (id: string) => `${id}.json`;
const ID = /^[0-9a-f]{48}$/;
const USER = typeof process.getuid === 'function' ? process.getuid() : undefined;

function privateDirectory(fd: number): void {
  const stat = fstatSync(fd);
  if (!stat.isDirectory() || (USER !== undefined && stat.uid !== USER) || (stat.mode & 0o077) !== 0) throw new Error('Untrusted state directory');
}

/** Linux /proc file-descriptor paths provide directory-relative operations.
 * On platforms without this facility fail closed until an equivalent is available. */
function fdPath(fd: number): string {
  if (process.platform !== 'linux') throw new Error('Safe receipt storage unavailable on this platform');
  return `/proc/self/fd/${fd}`;
}

function openDirectory(path: string): number {
  return openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}

function openStore(root: string, repository: string): number {
  // The root itself must already be private; it is never followed if symlinked.
  const rootFd = openDirectory(root);
  try {
    privateDirectory(rootFd);
    const name = digest(repository);
    const path = join(fdPath(rootFd), name);
    try { mkdirSync(path, { mode: 0o700 }); } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
    const namespace = openDirectory(path);
    try { privateDirectory(namespace); return namespace; } catch (error) { closeSync(namespace); throw error; }
  } finally { closeSync(rootFd); }
}

/** Create the default private state root only below the user's home directory. */
export function defaultStateRoot(): string {
  const home = resolve(homedir());
  const stat = lstatSync(home);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (USER !== undefined && stat.uid !== USER)) throw new Error('Untrusted home directory');
  const root = join(home, '.trail-test-impact-state');
  try { mkdirSync(root, { mode: 0o700 }); } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
  return root;
}

function readReceipt(dir: number, id: string): Receipt | null {
  if (!ID.test(id)) return null;
  let fd = -1;
  try {
    fd = openSync(join(fdPath(dir), filename(id)), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (USER !== undefined && stat.uid !== USER) || (stat.mode & 0o077) !== 0 || stat.size > 128 * 1024) return null;
    const item: Receipt = JSON.parse(readFileSync(fd, 'utf8'));
    if (item.version !== 1 || item.id !== id || !/^[0-9a-f]{40,64}$/.test(item.commit) || !/^[0-9a-f]{40,64}$/.test(item.tree) || typeof item.context !== 'string' || typeof item.profile !== 'string' || item.stable_inputs_assumed !== true || (item.predecessor !== null && (typeof item.predecessor !== 'string' || !ID.test(item.predecessor)))) return null;
    return item;
  } catch { return null; } finally { if (fd !== -1) closeSync(fd); }
}

function validChain(dir: number, receipt: Receipt): boolean {
  const visited = new Set<string>();
  let current: Receipt | null = receipt;
  while (current) {
    if (visited.has(current.id)) return false;
    visited.add(current.id);
    if (!current.predecessor) return true;
    const parent: Receipt | null = readReceipt(dir, current.predecessor);
    if (!parent || parent.profile !== current.profile || parent.context !== current.context) return false;
    current = parent;
  }
  return false;
}

export function findReceipt(root: string, repository: string, key: {commit: string; tree: string; context: string; profile: string}, beforeRead?: () => void): Receipt | null {
  let dir = -1;
  try {
    dir = openStore(root, repository);
    beforeRead?.();
    for (const name of readdirSync(fdPath(dir)).sort()) {
      if (!name.endsWith('.json')) continue;
      const receipt = readReceipt(dir, name.slice(0, -5));
      if (receipt && receipt.commit === key.commit && receipt.tree === key.tree && receipt.context === key.context && receipt.profile === key.profile && validChain(dir, receipt)) return receipt;
    }
  } catch { /* No trustworthy evidence. */ } finally { if (dir !== -1) closeSync(dir); }
  return null;
}

export async function publishReceipt(root: string, repository: string, data: Omit<Receipt, 'version' | 'id' | 'stable_inputs_assumed'>, beforePublish?: () => Promise<void>, failPublish?: () => void): Promise<Receipt> {
  const dir = openStore(root, repository);
  let temporary: string | undefined;
  try {
    if (data.predecessor) {
      const predecessor = readReceipt(dir, data.predecessor);
      if (!predecessor || predecessor.context !== data.context || predecessor.profile !== data.profile || !validChain(dir, predecessor)) throw new Error('Missing receipt predecessor');
    }
    await beforePublish?.();
    const id = randomBytes(24).toString('hex');
    const receipt: Receipt = { version: 1, id, ...data, stable_inputs_assumed: true };
    temporary = join(fdPath(dir), `.${id}.tmp`);
    writeFileSync(temporary, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
    failPublish?.();
    linkSync(temporary, join(fdPath(dir), filename(id)));
    unlinkSync(temporary);
    temporary = undefined;
    return receipt;
  } finally {
    if (temporary) { try { unlinkSync(temporary); } catch { /* best effort */ } }
    closeSync(dir);
  }
}
