/** Conservative Go package dependency facts, rebuilt from each committed tree.
 * This adapter deliberately accepts only a single module, no build constraints,
 * and a small set of fixed standard-library inputs. */
import { posix } from "node:path";
import { depthReady, parseDepth, warmDepthGrammars, type SyntaxNode } from "../graph/depth-parser.js";
import {recordDependency, type FileDependencyFacts} from "./dependency-facts.js";

export const GO_STATIC_MODEL = { id:"go-static-packages", version:"2" } as const;
export interface GoModel extends FileDependencyFacts { resources:Map<string,string>; moduleName:string; builtins:string[]; goVersion:string }
export interface GoIssue {path:string; kind:string; detail:string}
function walk(n:SyntaxNode, visit:(n:SyntaxNode)=>void):void { visit(n); for(const c of n.namedChildren) walk(c,visit); }

export async function certifyGoStatic(files:ReadonlyMap<string,Buffer>, issue:(x:GoIssue)=>void):Promise<GoModel|null> {
  const decoder=new TextDecoder("utf-8",{fatal:true});
  let moduleName:string,goVersion:string;
  try {
    const mod=decoder.decode(files.get("go.mod")!);
    const match=/^\s*module\s+([a-zA-Z0-9._~/-]+)\s+go\s+(1\.\d+(?:\.\d+)?)\s*$/.exec(mod);
    if (!match) return null;
    [,moduleName,goVersion]=match;
  } catch { return null; }
  await warmDepthGrammars(["go"]); if (!depthReady("go")) return null;
  const sources=[...files.keys()].filter(p=>p.endsWith(".go")).sort();
  if (!sources.length) return null;
  const packages=new Map<string,string[]>(), names=new Map<string,string>(), sourceImports=new Map<string,string[]>(), embeds=new Map<string,string[]>(), builtins=new Set<string>();
  let valid=true;
  const fail=(path:string,kind:string,detail:string)=>{valid=false;issue({path,kind,detail});};
  for (const path of sources) {
    try {
      const text=decoder.decode(files.get(path)!);
      // Go's filename suffix rules and build directives depend on platform/tags.
      if (/(?:^|_)(?:aix|android|darwin|dragonfly|freebsd|illumos|ios|js|linux|netbsd|openbsd|plan9|solaris|wasip1|windows|386|amd64|arm|arm64|loong64|mips|mips64|ppc64|riscv64|s390x|wasm)(?:_|\.go$)/.test(posix.basename(path)) || /(?:^|\n)\s*\/\/\s*(?:go:build|\+build|go:generate|go:linkname|go:cgo_)/.test(text)) fail(path,"unsupported_build_constraint","Platform-specific, generated, or build-constrained Go source");
      const rawImports:string[]=[]; let packageName="";
      parseDepth("go",text,root=>{
        if(root.hasError || root.isMissing) { fail(path,"parse_error","Go source contains parser errors or missing tokens"); return; }
        for(const node of root.namedChildren) {
          if(node.type === "package_clause") packageName=node.namedChildren[0]?.text ?? "";
          if(node.type === "import_declaration") walk(node,n=>{
            if(n.type !== "import_spec") return;
            const literal=n.namedChildren.find(c=>c.type === "interpreted_string_literal");
            if (!literal || !/^"[A-Za-z0-9._~/-]+"$/.test(literal.text)) {fail(path,"unresolved_import","Unsupported Go import literal");return;}
            rawImports.push(literal.text.slice(1,-1));
            if(literal.text === '"fmt"') {
              const alias=n.namedChildren.find(c=>c.type === "package_identifier" || c.type === "dot" || c.type === "blank_identifier");
              if(alias && alias.text !== "fmt") fail(path,"unsupported_standard_library","Aliased or dot fmt import is not modeled");
            }
          });
        }
        walk(root,n=>{
          if(n.type !== "selector_expression") return;
          const operand=n.childForFieldName("operand"), field=n.childForFieldName("field");
          if(operand?.text === "fmt" && (!field || !["Sprintf","Sprint","Sprintln","Errorf","Append","Appendf","Appendln"].includes(field.text))) fail(path,"unsupported_standard_library",`fmt.${field?.text ?? "?"} may access unmodeled inputs or effects`);
        });
      });
      if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(packageName)) {fail(path,"parse_error","Missing Go package declaration");continue;}
      const dir=posix.dirname(path), baseName=packageName.endsWith("_test") && path.endsWith("_test.go") ? packageName.slice(0,-5) : packageName;
      if(names.has(dir) && names.get(dir)!==baseName) fail(path,"package_mismatch","Multiple packages in one Go directory");
      names.set(dir,baseName); const members=packages.get(dir)??[];members.push(path);packages.set(dir,members);sourceImports.set(path,rawImports);
      const resources:string[]=[];
      for(const line of text.split(/\r?\n/)) {
        if(!/^\s*\/\/go:/.test(line)) continue;
        const m=/^\s*\/\/go:embed\s+([A-Za-z0-9_.-]+)\s*$/.exec(line);
        if(!m || m[1] === "." || m[1] === ".." || m[1].startsWith(".")) {fail(path,"unsupported_directive","Unsupported Go directive or embed pattern");continue;}
        const target=dir === "." ? m[1] : `${dir}/${m[1]}`;
        if(!files.has(target)) fail(path,"missing_input",`Embedded input ${target} is missing`); else resources.push(target);
      }
      embeds.set(path,resources);
    } catch {fail(path,"parse_error","Go source could not be decoded or parsed");}
  }
  const inputs=new Set([...embeds.values()].flat()), resources=new Map<string,string>();
  for(const [source,paths] of embeds) for(const path of paths) resources.set(path,posix.dirname(source));
  // These conventional documentation files cannot be read by supported Go
  // source: filesystem APIs are outside this adapter, while explicit embeds
  // above are always tracked as dependencies regardless of filename.
  for(const path of files.keys()) {
    if (/(?:^|\/)testdata(?:\/|$)/.test(path)) {fail(path,"unmodeled_input","Go testdata can contain automatically discovered corpus inputs");continue;}
    if(path !== "go.mod" && !sources.includes(path) && !inputs.has(path) && !/^(?:.*\/)?(?:README\.md|LICENSE)$/.test(path)) fail(path,"unmodeled_input","Go project input may affect test discovery or execution and is not covered by the static package model");
  }
  const facts:FileDependencyFacts={imports:new Map(),provenance:new Map()};
  for(const path of sources) {
    const dir=posix.dirname(path), edges=new Set((packages.get(dir)??[]).filter(p=>p!==path));
    facts.imports.set(path,[]);
    for(const member of edges) recordDependency(facts,path,member,`same Go package ${dir}`);
    for(const resource of embeds.get(path)??[]) recordDependency(facts,path,resource,`Go embed ${resource}`);
    for(const spec of sourceImports.get(path)??[]) {
      if(["testing","embed","strings","strconv","fmt"].includes(spec)) {builtins.add(spec);continue;}
      const target=spec === moduleName ? "." : spec.startsWith(moduleName+"/") ? spec.slice(moduleName.length+1) : null;
      const members=target === null ? undefined : packages.get(target);
      if(!members?.length) { fail(path,"unresolved_import",`Unresolved or unsupported Go import ${spec}`); continue; }
      for(const member of members) recordDependency(facts,path,member,`Go import ${spec}`);
    }
    facts.imports.get(path)!.sort();
  }
  return valid ? {...facts,resources,moduleName,builtins:[...builtins].sort(),goVersion} : null;
}
