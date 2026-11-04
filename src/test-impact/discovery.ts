import { spawnSync } from 'node:child_process';
import { posix } from 'node:path';
import { certifyNodeStatic } from '../impact/node-static.js';
import { certifyGoStatic } from '../impact/go-static.js';
import type { FileDependencyFacts } from '../impact/dependency-facts.js';
import type { DiscoveredModel } from './model-registry.js';

export interface DiscoveredComparison {
  model: DiscoveredModel;
  inventory: string[];
  affected: string[];
  /** Each independently established Go package boundary maps to its dependents. */
  scopes: Map<string, string[]>;
  requiredScopes: string[];
  /** Resolve any analyzer-reported file through the independently rebuilt graph. */
  dependentUnits(revision: "from" | "to", path: string): string[] | null;
}

function git(cwd: string, args: string[]): Buffer {
  const result = spawnSync('git', args, { cwd, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Cannot inspect committed Git objects');
  return result.stdout;
}

/** Read only Git blobs: checkout paths, symlinks, submodules and external files are never followed. */
function tree(cwd: string, commit: string): Map<string, Buffer> {
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error('Expected a pinned object ID');
  const listing = git(cwd, ['ls-tree', '-r', '-z', '--full-tree', commit]).toString('utf8');
  const files = new Map<string, Buffer>();
  for (const row of listing.split('\0').filter(Boolean)) {
    const entry = /^(\d{6}) (blob|commit) ([0-9a-f]+)\t([^\0]+)$/.exec(row);
    if (!entry || !['100644', '100755'].includes(entry[1]) || entry[2] !== 'blob') throw new Error('Unsupported committed input');
    if (files.has(entry[4])) throw new Error('Duplicate input');
    files.set(entry[4], git(cwd, ['cat-file', 'blob', entry[3]]));
  }
  return files;
}

function closure(changed: Set<string>, facts: FileDependencyFacts): Set<string> {
  const impacted = new Set(changed);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const [source, dependencies] of facts.imports) {
      if (!impacted.has(source) && dependencies.some(path => impacted.has(path))) {
        impacted.add(source); expanded = true;
      }
    }
  }
  return impacted;
}

/**
 * Independently reconstruct modeled facts from both immutable trees. A null
 * result is an incomplete discovery, never permission to narrow a run.
 */
export async function discoverComparison(cwd: string, from: string, to: string, kind: 'node' | 'go'): Promise<DiscoveredComparison | null> {
  try {
    const before = tree(cwd, from), after = tree(cwd, to);
    const changed = new Set([...before.keys(), ...after.keys()].filter(p => !before.get(p)?.equals(after.get(p) ?? Buffer.alloc(0)) || !after.has(p)));
    if (['package.json', 'tsconfig.json', 'go.mod'].some(p => changed.has(p))) return null;
    if (kind === 'node') {
      const a = await certifyNodeStatic(before), b = await certifyNodeStatic(after);
      if (!a || !b) return null;
      const inventory = [...after.keys()].filter(p => /^test\/[^/]+\.test\.ts$/.test(p)).sort();
      // The conventional fixture runner only discovers files directly in test/.
      if ([...after.keys()].some(p => p.endsWith('.test.ts') && !inventory.includes(p))) return null;
      const paths = new Set([...closure(changed, a), ...closure(changed, b)]);
      return { model: { id: 'node-typescript-static-esm', version: '3', complete: true, dependencies: [...new Set([...a.builtins, ...b.builtins])].sort() }, inventory, affected: inventory.filter(p => paths.has(p)), scopes: new Map(), requiredScopes: [],
        dependentUnits: (revision, path) => {const files=revision==='from'?before:after, model=revision==='from'?a:b;if(!files.has(path))return null;const reached=closure(new Set([path]),model);return inventory.filter(p=>reached.has(p));} };
    }
    const a = await certifyGoStatic(before, () => {}), b = await certifyGoStatic(after, () => {});
    if (!a || !b || a.moduleName !== b.moduleName || a.goVersion !== b.goVersion) return null;
    const unit = (p: string) => { const dir = posix.dirname(p); return dir === '.' ? '.' : `./${dir}`; };
    const inventory = [...new Set([...after.keys()].filter(p => p.endsWith('.go')).map(unit))].sort();
    const paths = new Set([...closure(changed, a), ...closure(changed, b)]);
    const scopes = new Map<string, string[]>();
    const requiredScopes = new Set<string>();
    for (const source of [a, b]) for (const dir of source.resources.values()) {
      const seed = new Set([...source.imports.keys()].filter(p => posix.dirname(p) === dir));
      const reached = closure(seed, source);
      const key = `go-package:${source.moduleName}:${dir}`;
      if ([...source.resources].some(([resource, owner]) => owner === dir && changed.has(resource))) requiredScopes.add(key);
      const previous = scopes.get(key) ?? [];
      scopes.set(key, [...new Set([...previous, ...inventory.filter(u => [...reached].some(p => p.endsWith('.go') && unit(p) === u))])].sort());
    }
    return { model: { id: 'go-static-packages', version: '2', complete: true, dependencies: [...new Set([...a.builtins, ...b.builtins])].sort(), goVersion: a.goVersion }, inventory, affected: inventory.filter(u => [...paths].some(p => p.endsWith('.go') && unit(p) === u)), scopes, requiredScopes: [...requiredScopes].sort(),
      dependentUnits: (revision, path) => {const files=revision==='from'?before:after, model=revision==='from'?a:b;if(!files.has(path))return null;const reached=closure(new Set([path]),model);return inventory.filter(u=>[...reached].some(p=>p.endsWith('.go')&&unit(p)===u));} };
  } catch { return null; }
}
