/**
 * Conditional, file-level Node/TypeScript ESM model. Only an explicitly
 * recognized syntactic subset is accepted; all other input is a full fallback.
 * Runtime/runner/configuration assumptions are independent v2 requirements.
 */
import { posix } from "node:path";
import { depthReady, parseDepth, warmDepthGrammars, type SyntaxNode } from "../graph/depth-parser.js";

export const NODE_STATIC_MODEL = { id:"node-typescript-static-esm", version:"1" } as const;
export interface StaticModel { imports: Map<string,string[]>; builtins: string[] }
type Bindings = {values:Set<string>; functions:Set<string>; modules:Set<string>; tests:Set<string>; asserts:Set<string>; imports:string[]; builtins:Set<string>};
const namePattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const safeName = (name:string) => namePattern.test(name) && !name.includes("__");
const literals = new Set(["number","true","false","null"]);
const compound = new Set(["binary_expression","unary_expression","parenthesized_expression","ternary_expression","arguments"]);
const assertions = new Set(["equal","strictEqual","deepEqual","deepStrictEqual","notEqual","notStrictEqual","ok"]);
function stringLiteral(n:SyntaxNode): boolean {
  return n.type === "string" && n.namedChildren.every(c => c.type === "string_fragment");
}
function specifier(n:SyntaxNode): string | null {
  if (!stringLiteral(n)) return null;
  const m = /^['"]([A-Za-z0-9_./:@-]+)['"]$/.exec(n.text);
  return m?.[1] ?? null;
}
function expr(n:SyntaxNode, b:Bindings, locals:Set<string>): boolean {
  if (literals.has(n.type) || stringLiteral(n)) return true;
  if (n.type === "identifier") return safeName(n.text) && (locals.has(n.text) || b.values.has(n.text));
  if (n.type === "member_expression") {
    const obj=n.childForFieldName("object"), prop=n.childForFieldName("property");
    return !!obj && obj.type === "identifier" && b.modules.has(obj.text) && !locals.has(obj.text) && !!prop && prop.type === "property_identifier" && safeName(prop.text);
  }
  if (n.type === "call_expression") {
    const fn=n.childForFieldName("function"), args=n.childForFieldName("arguments");
    if (!fn || !args || args.type !== "arguments") return false;
    const direct=fn.type === "identifier" && b.functions.has(fn.text) && !locals.has(fn.text);
    const member=fn.type === "member_expression" && expr(fn,b,locals);
    return (direct || member) && args.namedChildren.every(c => expr(c,b,locals));
  }
  return compound.has(n.type) && n.namedChildren.every(c => expr(c,b,locals));
}
function params(n:SyntaxNode): Set<string> | null {
  if (n.type !== "formal_parameters") return null;
  const out = new Set<string>();
  for (const p of n.namedChildren) {
    if (p.type !== "required_parameter") return null;
    const pattern=p.childForFieldName("pattern"), type=p.childForFieldName("type");
    if (!pattern || pattern.type !== "identifier" || !safeName(pattern.text) || out.has(pattern.text)) return null;
    if (p.namedChildren.some(c => c.id !== pattern.id && (!type || c.id !== type.id))) return null;
    if (type && (type.type !== "type_annotation" || type.namedChildren.length !== 1 || type.namedChildren[0].type !== "predefined_type" || !["number","string","boolean"].includes(type.namedChildren[0].text))) return null;
    out.add(pattern.text);
  }
  return out;
}
function returnType(n:SyntaxNode): boolean {
  return n.type === "type_annotation" && n.namedChildren.length === 1 && n.namedChildren[0].type === "predefined_type" && ["number","string","boolean","void"].includes(n.namedChildren[0].text);
}
function pureFunction(fn:SyntaxNode,b:Bindings): boolean {
  const parameters=fn.childForFieldName("parameters"), body=fn.childForFieldName("body"), name=fn.childForFieldName("name"), type=fn.childForFieldName("return_type");
  if (!parameters || !body || !name || fn.type !== "function_declaration" || /^async\b/.test(fn.text)) return false;
  if (type && !returnType(type)) return false;
  if (fn.namedChildren.some(c => ![parameters.id,body.id,name.id,type?.id].includes(c.id))) return false;
  const p=params(parameters); if (!p || body.type !== "statement_block") return false;
  for (const statement of body.namedChildren) {
    if (statement.type === "comment") continue;
    if (statement.type !== "return_statement" || statement.namedChildren.length > 1 || !statement.namedChildren.every(n => expr(n,b,p))) return false;
  }
  return true;
}
function testRegistration(n:SyntaxNode,b:Bindings): boolean {
  if (n.type !== "expression_statement" || n.namedChildren.length !== 1) return false;
  const call=n.namedChildren[0], fn=call.childForFieldName("function"), args=call.childForFieldName("arguments");
  if (call.type !== "call_expression" || !fn || fn.type !== "identifier" || !b.tests.has(fn.text) || !args || args.namedChildren.length !== 2 || !stringLiteral(args.namedChildren[0])) return false;
  const arrow=args.namedChildren[1], parameters=arrow.childForFieldName("parameters"), body=arrow.childForFieldName("body");
  if (arrow.type !== "arrow_function" || /^async\b/.test(arrow.text) || !parameters || parameters.namedChildren.length || !body || body.type !== "statement_block") return false;
  for (const st of body.namedChildren) {
    if (st.type === "comment") continue;
    if (st.type !== "expression_statement" || st.namedChildren.length !== 1) return false;
    const c=st.namedChildren[0], target=c.childForFieldName("function"), a=c.childForFieldName("arguments");
    if (c.type !== "call_expression" || !target || target.type !== "member_expression" || !a) return false;
    const obj=target.childForFieldName("object"), property=target.childForFieldName("property");
    if (!obj || obj.type !== "identifier" || !b.asserts.has(obj.text) || !property || !assertions.has(property.text)) return false;
    if (!a.namedChildren.every(x => expr(x,b,new Set()))) return false;
  }
  return true;
}
function filePath(path:string): boolean { return /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.test)?\.ts$/.test(path) && !path.endsWith(".d.ts"); }
function resolveLocal(source:string, value:string, paths:Set<string>): string | null {
  if (!value.startsWith("./") && !value.startsWith("../")) return null;
  const base=posix.normalize(posix.join(posix.dirname(source),value));
  if (base === ".." || base.startsWith("../") || posix.isAbsolute(base)) return null;
  const candidates = value.endsWith(".js") ? [base.slice(0,-3)+".ts"] : value.endsWith(".ts") ? [base] : [];
  const hits=candidates.filter(x => paths.has(x));
  return hits.length === 1 ? hits[0] : null;
}
function parseBindings(clause:SyntaxNode | undefined, category:"local"|"test"|"assert",b:Bindings): boolean {
  if (!clause) return category === "local";
  if (clause.type !== "import_clause") return false;
  for (const item of clause.namedChildren) {
    if (item.type === "identifier") {
      if (category !== "assert" || !safeName(item.text) || b.values.has(item.text)) return false;
      b.asserts.add(item.text); b.values.add(item.text);
    } else if (item.type === "namespace_import") {
      if (category !== "local" || item.namedChildren.length !== 1 || !safeName(item.namedChildren[0].text) || b.values.has(item.namedChildren[0].text)) return false;
      b.modules.add(item.namedChildren[0].text); b.values.add(item.namedChildren[0].text);
    } else if (item.type === "named_imports") {
      for (const imp of item.namedChildren) {
        if (imp.type !== "import_specifier") return false;
        const original=imp.childForFieldName("name"), alias=imp.childForFieldName("alias") ?? original;
        if (!original || !alias || !safeName(original.text) || !safeName(alias.text) || b.values.has(alias.text)) return false;
        if (category === "assert" || (category === "test" && original.text !== "test")) return false;
        b.values.add(alias.text); (category === "test" ? b.tests : b.functions).add(alias.text);
      }
    } else return false;
  }
  return true;
}
function sourceFile(root:SyntaxNode,path:string,paths:Set<string>): {imports:string[]; builtins:string[]} | null {
  if (root.type !== "program") return null;
  const b:Bindings={values:new Set(),functions:new Set(),modules:new Set(),tests:new Set(),asserts:new Set(),imports:[],builtins:new Set()};
  const functions:SyntaxNode[]=[], tests:SyntaxNode[]=[];
  for (const top of root.namedChildren) {
    if (top.type === "comment") continue;
    if (top.type === "import_statement" || (top.type === "export_statement" && !!top.childForFieldName("source"))) {
      const src=top.childForFieldName("source"), value=src && specifier(src);
      if (!value) return null;
      const local=resolveLocal(path,value,paths);
      let category:"local"|"test"|"assert";
      if (local) { category="local"; b.imports.push(local); }
      else if (value === "node:test") { category="test"; b.builtins.add(value); }
      else if (value === "node:assert/strict") { category="assert"; b.builtins.add(value); }
      else return null;
      if (top.type === "import_statement") {
        const clause=top.namedChildren.find(c => c.type === "import_clause");
        if (top.namedChildren.some(c => c.id !== src!.id && (!clause || c.id !== clause.id))) return null;
        if (!parseBindings(clause,category,b)) return null;
      } else {
        if (category !== "local") return null;
        // A re-export can expose any imported value but always depends on that
        // entire file; dynamic/export assignment forms are not accepted.
        if (top.namedChildren.some(c => c.id !== src!.id && c.type !== "export_clause")) return null;
      }
      continue;
    }
    const node=top.type === "export_statement" ? top.childForFieldName("declaration") : top;
    if (!node) return null;
    if (node.type === "function_declaration") {
      const name=node.childForFieldName("name");
      if (!name || !safeName(name.text) || b.values.has(name.text)) return null;
      b.functions.add(name.text);b.values.add(name.text);functions.push(node);
    } else if (node.type === "lexical_declaration" && /^const\b/.test(node.text)) {
      for (const decl of node.namedChildren) {
        const name=decl.childForFieldName("name"), value=decl.childForFieldName("value");
        if (decl.type !== "variable_declarator" || !name || name.type !== "identifier" || !safeName(name.text) || b.values.has(name.text) || !value || !(literals.has(value.type) || stringLiteral(value))) return null;
        b.values.add(name.text);
      }
    } else if (top.type === "expression_statement") tests.push(top);
    else return null;
  }
  for (const fn of functions) if (!pureFunction(fn,b)) return null;
  for (const statement of tests) if (!testRegistration(statement,b)) return null;
  return {imports:[...new Set(b.imports)].sort(),builtins:[...b.builtins].sort()};
}
function configValid(files:ReadonlyMap<string,Buffer>):boolean {
  try {
    const decoder=new TextDecoder("utf-8",{fatal:true});
    const pkg=JSON.parse(decoder.decode(files.get("package.json")!));
    if (!pkg || Array.isArray(pkg) || typeof pkg !== "object" || pkg.type !== "module" || Object.keys(pkg).some(k => !["name","version","private","type"].includes(k))) return false;
    if ((pkg.name !== undefined && typeof pkg.name !== "string") || (pkg.version !== undefined && typeof pkg.version !== "string") || (pkg.private !== undefined && typeof pkg.private !== "boolean")) return false;
    const cfg=JSON.parse(decoder.decode(files.get("tsconfig.json")!));
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg) || Object.keys(cfg).some(k => k !== "compilerOptions")) return false;
    const o=cfg.compilerOptions;
    if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).some(k => !["module","moduleResolution","target","strict","noEmit","skipLibCheck"].includes(k))) return false;
    if (typeof o.module !== "string" || o.module.toLowerCase() !== "nodenext" || typeof o.moduleResolution !== "string" || o.moduleResolution.toLowerCase() !== "nodenext" || typeof o.target !== "string" || o.target.toLowerCase() !== "es2022") return false;
    return ["strict","noEmit","skipLibCheck"].every(k => o[k] === undefined || typeof o[k] === "boolean");
  } catch { return false; }
}
/** Certify only flat ESM dependency semantics; unsupported constructs return null. */
export async function certifyNodeStatic(files:ReadonlyMap<string,Buffer>): Promise<StaticModel | null> {
  if (!files.has("package.json") || !files.has("tsconfig.json") || !configValid(files)) return null;
  const paths=new Set([...files.keys()].filter(filePath));
  if (!paths.size || [...files.keys()].some(p => !paths.has(p) && !["package.json","tsconfig.json"].includes(p))) return null;
  await warmDepthGrammars(["typescript"]);if (!depthReady("typescript")) return null;
  const decoder=new TextDecoder("utf-8",{fatal:true}), imports=new Map<string,string[]>(), builtins=new Set<string>();
  try {
    for (const path of [...paths].sort()) {
      const source=decoder.decode(files.get(path)!);
      const result=parseDepth("typescript",source,root=>sourceFile(root,path,paths));
      if (!result) return null;
      imports.set(path,result.imports);for (const b of result.builtins) builtins.add(b);
    }
  } catch { return null; }
  return {imports,builtins:[...builtins].sort()};
}
