/**
 * The consumer's model registry.  Inputs to this module must be obtained from
 * independent discovery, never from the analyzer report being validated.
 * Validating these declarations alone does not validate execution evidence.
 */
export type DiscoveredModel =
  | { id: 'node-typescript-static-esm'; version: '3'; dependencies: readonly string[]; complete: boolean }
  | { id: 'go-static-packages'; version: '2'; dependencies: readonly string[]; goVersion: string; complete: boolean };

type Requirement = { id: string; kind: string; predicate: Record<string, string>; evidence_kind: string };

function requirement(id: string, op: string, evidence_kind: string, parameters: Record<string, string> = {}): Requirement {
  return { id, kind: id, predicate: { op, ...parameters }, evidence_kind };
}

/** Returns no registry when discovery is incomplete or names unsupported inputs. */
export function expectedRequirements(discovery: DiscoveredModel): Requirement[] | null {
  if (!discovery.complete || !Array.isArray(discovery.dependencies)) return null;
  const isGo = discovery.id === 'go-static-packages' && discovery.version === '2';
  const isNode = discovery.id === 'node-typescript-static-esm' && discovery.version === '3';
  if (!isGo && !isNode) return null;
  const goVersion = isGo && 'goVersion' in discovery ? discovery.goVersion : undefined;
  if (isGo && (typeof goVersion !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/.test(goVersion))) return null;
  const supported = isGo
    ? new Set(['testing', 'embed', 'strings', 'strconv', 'fmt'])
    : new Set(['node:test', 'node:assert/strict', 'npm:tsx', 'npm:typescript']);
  if (discovery.dependencies.some(d => typeof d !== 'string' || !supported.has(d))) return null;
  const requirements = [
    requirement('baseline', 'compatible_passing_receipt_for_from_and_profile', 'receipt_validation'),
    requirement('environment', 'complete_relevant_environment_for_execution', 'environment_observation'),
    requirement('inputs', 'complete_inputs_for_target_and_profile', 'input_discovery'),
    requirement('inventory', 'complete_inventory_for_target_and_profile', 'runner_discovery'),
    requirement('resolver', isGo ? 'supported_go_package_resolver' : 'supported_node_typescript_resolver', 'resolver_observation', goVersion ? { go_version: goVersion } : {}),
    requirement('runner', 'supported_runner_for_target_and_profile', 'runner_observation'),
    requirement('runtime', isGo ? 'supported_go_runtime' : 'supported_node_runtime', 'runtime_observation', goVersion ? { go_version: goVersion } : {}),
  ];
  for (const specifier of new Set(discovery.dependencies)) {
    requirements.push({
      id: `dependency:${specifier}`, kind: 'dependency', evidence_kind: 'dependency_observation',
      predicate: { op: isGo ? 'go_standard_package_matches_runtime' : specifier.startsWith('npm:') ? 'node_external_dependency_matches_execution' : 'node_builtin_matches_runtime', specifier },
    });
  }
  return requirements.sort((a, b) => a.id.localeCompare(b.id));
}

function canonical(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${canonical(val)}`).join(',')}}`;
}

/** Exact comparison rejects omissions, duplicates, extra properties and weaker predicates. */
export function validateModelRequirements(model: unknown, reported: unknown, discovery: DiscoveredModel): boolean {
  const expected = expectedRequirements(discovery);
  if (!expected || !model || typeof model !== 'object' || Array.isArray(model) || !Array.isArray(reported)) return false;
  if (canonical(model) !== canonical({ id: discovery.id, version: discovery.version })) return false;
  if (reported.length !== expected.length) return false;
  const sorted = [...reported].sort((a, b) => String(a?.id).localeCompare(String(b?.id)));
  return canonical(sorted) === canonical(expected);
}
