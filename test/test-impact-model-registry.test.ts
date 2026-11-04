import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectedRequirements, validateModelRequirements, type DiscoveredModel } from '../src/test-impact/model-registry.js';

const discovered: DiscoveredModel = { id: 'node-typescript-static-esm', version: '3', complete: true, dependencies: ['node:test', 'node:assert/strict'] };
const model = { id: discovered.id, version: discovered.version };

test('consumer registry rejects altered or incomplete model requirements', () => {
  const expected = expectedRequirements(discovered)!;
  assert.ok(validateModelRequirements(model, expected, discovered));
  assert.ok(!validateModelRequirements({ ...model, version: '4' }, expected, discovered));
  assert.ok(!validateModelRequirements(model, expected.slice(1), discovered));
  assert.ok(!validateModelRequirements(model, [...expected, expected[0]], discovered));
  assert.ok(!validateModelRequirements(model, expected.map((r, i) => i ? r : { ...r, evidence_kind: 'analyzer_assertion' }), discovered));
  assert.ok(!validateModelRequirements(model, expected, { ...discovered, complete: false }));
  assert.equal(expectedRequirements({ ...discovered, dependencies: ['node:fs'] }), null);
});

test('Go registry binds the independently discovered language version', () => {
  const go: DiscoveredModel = { id: 'go-static-packages', version: '2', complete: true, dependencies: ['testing'], goVersion: '1.22' };
  const expected = expectedRequirements(go)!;
  assert.ok(validateModelRequirements({id: go.id, version: go.version}, expected, go));
  assert.ok(!validateModelRequirements({id: go.id, version: go.version}, expected, { ...go, goVersion: '1.23' }));
});
