/** Raw, snapshot-local file dependency facts. Adapters rebuild these from
 * committed bytes; they are never read from the navigation extraction cache. */
export interface FileDependencyFacts {
  imports: Map<string,string[]>;
  /** Source path -> target path -> all raw relationship evidence. */
  provenance: Map<string,Map<string,string[]>>;
}
export function recordDependency(facts:FileDependencyFacts, source:string, target:string, evidence:string):void {
  const targets=facts.imports.get(source) ?? [];
  if (!targets.includes(target)) targets.push(target);
  facts.imports.set(source,targets);
  const byTarget=facts.provenance.get(source) ?? new Map<string,string[]>();
  const reasons=byTarget.get(target) ?? [];
  if (!reasons.includes(evidence)) reasons.push(evidence);
  byTarget.set(target,reasons);facts.provenance.set(source,byTarget);
}
