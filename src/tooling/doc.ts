import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";
import type {
  Program,
  SchemaDeclaration,
  ServiceDeclaration,
  ErrorDeclaration,
  BindingDeclaration,
  FunctionExpression,
} from "../ast/types.js";

export interface DocField {
  name: string;
  type: string;
  optional?: boolean;
}

export interface DocVariant {
  name: string;
  fields?: DocField[];
}

export interface DocSchema {
  name: string;
  kind: "record" | "tagged-union" | "structural-union" | "contract" | "custom";
  docComment?: string;
  typeParams?: string[];
  fields?: DocField[];
  variants?: DocVariant[];
  sourceCode: string;
}

export interface DocServiceMethod {
  name: string;
  signature: string;
}

export interface DocService {
  name: string;
  docComment?: string;
  methods: DocServiceMethod[];
  sourceCode: string;
}

export interface DocFunctionParam {
  name: string;
  type?: string;
}

export interface DocFunction {
  name: string;
  signature: string;
  params: DocFunctionParam[];
  returnType?: string;
  docComment?: string;
  exampleSnippets?: string[];
  sourceCode: string;
}

export interface DocError {
  name: string;
  docComment?: string;
  fields?: DocField[];
  sourceCode: string;
}

export interface DocBinding {
  name: string;
  docComment?: string;
  sourceCode: string;
}

export interface DocModule {
  filePath: string;
  moduleName: string;
  docComment?: string;
  schemas: DocSchema[];
  services: DocService[];
  functions: DocFunction[];
  errors: DocError[];
  bindings: DocBinding[];
}

export interface DocProject {
  title: string;
  version?: string;
  modules: DocModule[];
}

export interface DocOptions {
  outDir?: string;
  format?: "html" | "markdown" | "json";
  open?: boolean;
  title?: string;
}

function extractPrecedingDocComment(
  source: string,
  startOffset: number,
): string | undefined {
  const before = source.slice(0, startOffset);
  const match = before.match(/(?:^|\n)((?:[ \t]*\/\/\/[^\n]*\n)+)[ \t]*$/);
  if (!match) return undefined;
  return match[1]
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/\/ ?/, ""))
    .join("\n")
    .trim();
}

function extractModuleDocComment(
  source: string,
  firstDeclOffset: number,
): string | undefined {
  const topText = source.slice(0, firstDeclOffset);
  const match = topText.match(
    /(?:^|\n)((?:[ \t]*\/\/(?:!|\/)[^\n]*\n)+)[ \t]*$/,
  );
  if (!match) return undefined;
  return match[1]
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/(?:!|\/) ?/, ""))
    .join("\n")
    .trim();
}

function extractExamples(docComment?: string): string[] {
  if (!docComment) return [];
  const regex = /```(?:funscript)?\n([\s\S]*?)```/g;
  const examples: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(docComment)) !== null) {
    examples.push(m[1].trim());
  }
  return examples;
}

export function extractModuleDoc(
  source: string,
  filePath: string,
  projectRoot: string,
): DocModule {
  const relPath = path.relative(projectRoot, filePath).replace(/\\/g, "/");
  const moduleName = relPath.replace(/\.funx?$/, "");

  let program: Program;
  try {
    const lexer = new Lexer(source, filePath);
    const tokens = lexer.tokenize();
    program = new Parser(tokens, filePath, source).parse();
  } catch {
    return {
      filePath: relPath,
      moduleName,
      schemas: [],
      services: [],
      functions: [],
      errors: [],
      bindings: [],
    };
  }

  const firstOffset =
    program.body.length > 0 ? program.body[0].span.start.offset : source.length;
  const moduleDoc = extractModuleDocComment(source, firstOffset);

  const schemas: DocSchema[] = [];
  const services: DocService[] = [];
  const functions: DocFunction[] = [];
  const errors: DocError[] = [];
  const bindings: DocBinding[] = [];

  for (const entry of program.body) {
    const isExported = entry.kind === "ExportDeclaration";
    const decl = isExported ? entry.declaration : entry;
    const docComment = extractPrecedingDocComment(
      source,
      entry.span.start.offset,
    );
    const sourceCode = source
      .slice(entry.span.start.offset, entry.span.end.offset)
      .trim();

    if (decl.kind === "SchemaDeclaration") {
      const sdecl = decl;
      const name = sdecl.id.name;
      const typeParams = sdecl.typeParams?.map((p) => p.name.name);
      let kind: DocSchema["kind"] = "custom";
      let fields: DocField[] | undefined;
      let variants: DocVariant[] | undefined;

      if (sdecl.body.kind === "RecordSchema") {
        kind = "record";
        fields = sdecl.body.fields.map((f) => ({
          name: f.name.name,
          type: source
            .slice(
              f.typeAnnotation.span.start.offset,
              f.typeAnnotation.span.end.offset,
            )
            .trim(),
          optional: f.optional,
        }));
      } else if (sdecl.body.kind === "TaggedUnionSchema") {
        kind = "tagged-union";
        variants = sdecl.body.variants.map((v) => ({
          name: v.name.name,
          fields: v.fields.map((vf) => ({
            name: vf.name.name,
            type: source
              .slice(
                vf.typeAnnotation.span.start.offset,
                vf.typeAnnotation.span.end.offset,
              )
              .trim(),
          })),
        }));
      } else if (sdecl.body.kind === "StructuralUnionSchema") {
        kind = "structural-union";
      }

      schemas.push({
        name,
        kind,
        typeParams,
        fields,
        variants,
        docComment,
        sourceCode,
      });
    } else if (decl.kind === "ServiceDeclaration") {
      const sdecl = decl;
      const name = sdecl.id.name;
      const methods = sdecl.members.map((m) => ({
        name: m.name.name,
        signature: source
          .slice(m.signature.span.start.offset, m.signature.span.end.offset)
          .trim(),
      }));
      services.push({
        name,
        methods,
        docComment,
        sourceCode,
      });
    } else if (decl.kind === "ErrorDeclaration") {
      const edecl = decl;
      const name = edecl.id.name;
      const fields = edecl.fields.map((f) => ({
        name: f.name.name,
        type: source
          .slice(
            f.typeAnnotation.span.start.offset,
            f.typeAnnotation.span.end.offset,
          )
          .trim(),
      }));
      errors.push({
        name,
        fields,
        docComment,
        sourceCode,
      });
    } else if (decl.kind === "BindingDeclaration") {
      const bdecl = decl;
      if (bdecl.id.kind === "Identifier") {
        const name = bdecl.id.name;
        if (bdecl.init.kind === "FunctionExpression") {
          const fn = bdecl.init;
          const params = fn.params.map((p) => ({
            name: "name" in p && p.name ? (p.name as any).name : "arg",
            type: p.typeAnnotation
              ? source
                  .slice(
                    p.typeAnnotation.span.start.offset,
                    p.typeAnnotation.span.end.offset,
                  )
                  .trim()
              : undefined,
          }));
          const returnType = fn.returnType
            ? source
                .slice(
                  fn.returnType.span.start.offset,
                  fn.returnType.span.end.offset,
                )
                .trim()
            : undefined;

          const paramSig = params
            .map((p) => (p.type ? `${p.name}: ${p.type}` : p.name))
            .join(", ");
          const retSig = returnType ? `: ${returnType}` : "";
          const signature = `${name} = (${paramSig})${retSig} => ...`;

          functions.push({
            name,
            signature,
            params,
            returnType,
            docComment,
            exampleSnippets: extractExamples(docComment),
            sourceCode,
          });
        } else {
          bindings.push({
            name,
            docComment,
            sourceCode,
          });
        }
      }
    }
  }

  return {
    filePath: relPath,
    moduleName,
    docComment: moduleDoc,
    schemas,
    services,
    functions,
    errors,
    bindings,
  };
}

export function renderMarkdownDoc(project: DocProject): string {
  const lines: string[] = [];
  lines.push(`# ${project.title}`);
  if (project.version) {
    lines.push(`Version: \`${project.version}\`\n`);
  }
  lines.push("");

  lines.push("## Modules");
  for (const mod of project.modules) {
    lines.push(
      `- [${mod.moduleName}](#module-${mod.moduleName.replace(/[^a-zA-Z0-9_-]/g, "-")})`,
    );
  }
  lines.push("");

  for (const mod of project.modules) {
    lines.push(`---\n\n## Module: \`${mod.moduleName}\``);
    if (mod.docComment) {
      lines.push(`\n${mod.docComment}\n`);
    }

    if (mod.schemas.length > 0) {
      lines.push("### Schemas\n");
      for (const s of mod.schemas) {
        lines.push(`#### \`${s.name}\` (${s.kind})`);
        if (s.docComment) lines.push(`\n${s.docComment}\n`);
        lines.push("```funscript\n" + s.sourceCode + "\n```");
        if (s.fields && s.fields.length > 0) {
          lines.push("\n| Field | Type | Optional |");
          lines.push("| :--- | :--- | :--- |");
          for (const f of s.fields) {
            lines.push(
              `| \`${f.name}\` | \`${f.type}\` | ${f.optional ? "Yes" : "No"} |`,
            );
          }
          lines.push("");
        }
        if (s.variants && s.variants.length > 0) {
          lines.push("\n| Variant | Fields |");
          lines.push("| :--- | :--- |");
          for (const v of s.variants) {
            const fStr =
              v.fields?.map((vf) => `${vf.name}: ${vf.type}`).join(", ") ||
              "(empty)";
            lines.push(`| \`${v.name}\` | \`${fStr}\` |`);
          }
          lines.push("");
        }
      }
    }

    if (mod.services.length > 0) {
      lines.push("### Services\n");
      for (const s of mod.services) {
        lines.push(`#### Service: \`${s.name}\``);
        if (s.docComment) lines.push(`\n${s.docComment}\n`);
        lines.push("```funscript\n" + s.sourceCode + "\n```");
        if (s.methods.length > 0) {
          lines.push("\n| Method | Signature |");
          lines.push("| :--- | :--- |");
          for (const m of s.methods) {
            lines.push(`| \`${m.name}\` | \`${m.signature}\` |`);
          }
          lines.push("");
        }
      }
    }

    if (mod.functions.length > 0) {
      lines.push("### Functions\n");
      for (const fn of mod.functions) {
        lines.push(`#### \`${fn.name}\``);
        if (fn.docComment) lines.push(`\n${fn.docComment}\n`);
        lines.push("```funscript\n" + fn.signature + "\n```");
        if (fn.exampleSnippets && fn.exampleSnippets.length > 0) {
          lines.push(
            "\n**Example:**\n```funscript\n" +
              fn.exampleSnippets.join("\n\n") +
              "\n```",
          );
        }
        lines.push("");
      }
    }

    if (mod.errors.length > 0) {
      lines.push("### Errors\n");
      for (const err of mod.errors) {
        lines.push(`#### Error: \`${err.name}\``);
        if (err.docComment) lines.push(`\n${err.docComment}\n`);
        lines.push("```funscript\n" + err.sourceCode + "\n```\n");
      }
    }
  }

  return lines.join("\n");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function renderHtmlDoc(project: DocProject): string {
  const totalSchemas = project.modules.reduce(
    (acc, m) => acc + m.schemas.length,
    0,
  );
  const totalServices = project.modules.reduce(
    (acc, m) => acc + m.services.length,
    0,
  );
  const totalFunctions = project.modules.reduce(
    (acc, m) => acc + m.functions.length,
    0,
  );

  const sidebarModules = project.modules
    .map((m) => {
      const safeId = m.moduleName.replace(/[^a-zA-Z0-9_-]/g, "-");
      return `
      <div class="sidebar-item" data-module="${escapeHtml(m.moduleName)}">
        <a href="#module-${safeId}">${escapeHtml(m.moduleName)}</a>
      </div>`;
    })
    .join("");

  const modulesHtml = project.modules
    .map((m) => {
      const safeId = m.moduleName.replace(/[^a-zA-Z0-9_-]/g, "-");
      const schemasHtml = m.schemas
        .map((s) => {
          const fieldsTable = s.fields?.length
            ? `<table class="doc-table">
                <thead><tr><th>Field</th><th>Type</th><th>Optional</th></tr></thead>
                <tbody>
                  ${s.fields.map((f) => `<tr><td><code>${escapeHtml(f.name)}</code></td><td><code>${escapeHtml(f.type)}</code></td><td>${f.optional ? "Yes" : "No"}</td></tr>`).join("")}
                </tbody>
               </table>`
            : "";

          const variantsTable = s.variants?.length
            ? `<table class="doc-table">
                <thead><tr><th>Variant</th><th>Fields</th></tr></thead>
                <tbody>
                  ${s.variants
                    .map((v) => {
                      const fStr =
                        v.fields
                          ?.map((vf) => `${vf.name}: ${vf.type}`)
                          .join(", ") || "(empty)";
                      return `<tr><td><code>${escapeHtml(v.name)}</code></td><td><code>${escapeHtml(fStr)}</code></td></tr>`;
                    })
                    .join("")}
                </tbody>
               </table>`
            : "";

          return `
          <div class="doc-card" data-kind="schema" data-name="${escapeHtml(s.name)}">
            <div class="doc-card-header">
              <span class="badge badge-schema">schema</span>
              <h4 id="${safeId}-${escapeHtml(s.name)}">${escapeHtml(s.name)} <span class="badge-kind">(${s.kind})</span></h4>
            </div>
            ${s.docComment ? `<p class="doc-comment">${escapeHtml(s.docComment)}</p>` : ""}
            <pre><code>${escapeHtml(s.sourceCode)}</code></pre>
            ${fieldsTable}
            ${variantsTable}
          </div>`;
        })
        .join("");

      const servicesHtml = m.services
        .map((s) => {
          const methodsTable = s.methods.length
            ? `<table class="doc-table">
                <thead><tr><th>Method</th><th>Signature</th></tr></thead>
                <tbody>
                  ${s.methods.map((method) => `<tr><td><code>${escapeHtml(method.name)}</code></td><td><code>${escapeHtml(method.signature)}</code></td></tr>`).join("")}
                </tbody>
               </table>`
            : "";

          return `
          <div class="doc-card" data-kind="service" data-name="${escapeHtml(s.name)}">
            <div class="doc-card-header">
              <span class="badge badge-service">service</span>
              <h4 id="${safeId}-${escapeHtml(s.name)}">${escapeHtml(s.name)}</h4>
            </div>
            ${s.docComment ? `<p class="doc-comment">${escapeHtml(s.docComment)}</p>` : ""}
            <pre><code>${escapeHtml(s.sourceCode)}</code></pre>
            ${methodsTable}
          </div>`;
        })
        .join("");

      const functionsHtml = m.functions
        .map((fn) => {
          return `
          <div class="doc-card" data-kind="function" data-name="${escapeHtml(fn.name)}">
            <div class="doc-card-header">
              <span class="badge badge-fn">function</span>
              <h4 id="${safeId}-${escapeHtml(fn.name)}">${escapeHtml(fn.name)}</h4>
            </div>
            ${fn.docComment ? `<p class="doc-comment">${escapeHtml(fn.docComment)}</p>` : ""}
            <pre><code>${escapeHtml(fn.signature)}</code></pre>
            ${fn.exampleSnippets?.length ? `<div class="example-box"><strong>Example</strong><pre><code>${escapeHtml(fn.exampleSnippets.join("\n\n"))}</code></pre></div>` : ""}
          </div>`;
        })
        .join("");

      const errorsHtml = m.errors
        .map((err) => {
          return `
          <div class="doc-card" data-kind="error" data-name="${escapeHtml(err.name)}">
            <div class="doc-card-header">
              <span class="badge badge-error">error</span>
              <h4 id="${safeId}-${escapeHtml(err.name)}">${escapeHtml(err.name)}</h4>
            </div>
            ${err.docComment ? `<p class="doc-comment">${escapeHtml(err.docComment)}</p>` : ""}
            <pre><code>${escapeHtml(err.sourceCode)}</code></pre>
          </div>`;
        })
        .join("");

      return `
      <section class="module-section" id="module-${safeId}" data-module="${escapeHtml(m.moduleName)}">
        <div class="module-header">
          <h2>Module: <code>${escapeHtml(m.moduleName)}</code></h2>
          <span class="file-path">${escapeHtml(m.filePath)}</span>
        </div>
        ${m.docComment ? `<p class="module-doc">${escapeHtml(m.docComment)}</p>` : ""}
        ${schemasHtml ? `<h3>Schemas</h3><div class="cards-grid">${schemasHtml}</div>` : ""}
        ${servicesHtml ? `<h3>Services</h3><div class="cards-grid">${servicesHtml}</div>` : ""}
        ${functionsHtml ? `<h3>Functions</h3><div class="cards-grid">${functionsHtml}</div>` : ""}
        ${errorsHtml ? `<h3>Errors</h3><div class="cards-grid">${errorsHtml}</div>` : ""}
      </section>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(project.title)} — API Reference</title>
  <style>
    :root {
      --bg: #0d1117;
      --card-bg: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --heading: #f0f6fc;
      --link: #58a6ff;
      --code-bg: #1f242c;
      --badge-schema: #a371f7;
      --badge-service: #3fb950;
      --badge-fn: #58a6ff;
      --badge-error: #f85149;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      min-height: 100vh;
      line-height: 1.5;
    }
    a { color: var(--link); text-decoration: none; }
    a:hover { text-decoration: underline; }
    #sidebar {
      width: 280px;
      background: var(--card-bg);
      border-right: 1px solid var(--border);
      position: sticky;
      top: 0;
      height: 100vh;
      overflow-y: auto;
      padding: 20px;
      flex-shrink: 0;
    }
    .brand { font-size: 1.25rem; font-weight: bold; color: var(--heading); margin-bottom: 4px; }
    .version { font-size: 0.85rem; color: #8b949e; margin-bottom: 16px; }
    .search-box { width: 100%; padding: 8px 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; color: var(--text); margin-bottom: 20px; font-size: 0.9rem; }
    .search-box:focus { outline: none; border-color: var(--link); }
    .sidebar-title { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #8b949e; margin-bottom: 8px; }
    .sidebar-item { padding: 4px 0; font-size: 0.9rem; }
    #content { flex: 1; padding: 40px; max-width: 1100px; margin: 0 auto; overflow-y: auto; }
    .hero-stats { display: flex; gap: 16px; margin: 20px 0 40px; }
    .stat-pill { background: var(--card-bg); border: 1px solid var(--border); padding: 8px 16px; border-radius: 20px; font-size: 0.85rem; }
    .module-section { margin-bottom: 60px; scroll-margin-top: 20px; }
    .module-header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid var(--border); padding-bottom: 8px; margin-bottom: 16px; }
    .module-header h2 { color: var(--heading); font-size: 1.5rem; }
    .file-path { font-size: 0.85rem; color: #8b949e; font-family: monospace; }
    .module-doc { margin-bottom: 24px; color: #8b949e; }
    h3 { color: var(--heading); font-size: 1.15rem; margin: 24px 0 12px; }
    .cards-grid { display: flex; flex-direction: column; gap: 16px; margin-bottom: 24px; }
    .doc-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
    .doc-card-header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
    .doc-card h4 { color: var(--heading); font-size: 1.1rem; }
    .badge { font-size: 0.7rem; font-weight: bold; text-transform: uppercase; padding: 2px 6px; border-radius: 4px; color: #fff; }
    .badge-schema { background: var(--badge-schema); }
    .badge-service { background: var(--badge-service); }
    .badge-fn { background: var(--badge-fn); }
    .badge-error { background: var(--badge-error); }
    .badge-kind { font-size: 0.85rem; font-weight: normal; color: #8b949e; }
    .doc-comment { margin-bottom: 12px; color: #8b949e; }
    pre { background: var(--code-bg); padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 0.9rem; font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; border: 1px solid var(--border); margin-bottom: 12px; }
    .doc-table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 0.85rem; }
    .doc-table th, .doc-table td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); }
    .doc-table th { color: #8b949e; }
    .example-box { background: rgba(88, 166, 255, 0.05); border-left: 3px solid var(--link); padding: 10px; border-radius: 4px; margin-top: 12px; }
    .example-box strong { font-size: 0.8rem; text-transform: uppercase; color: var(--link); }
    @media (max-width: 800px) {
      body { flex-direction: column; }
      #sidebar { width: 100%; height: auto; position: static; }
      #content { padding: 20px; }
    }
  </style>
</head>
<body>
  <nav id="sidebar">
    <div class="brand">${escapeHtml(project.title)}</div>
    ${project.version ? `<div class="version">v${escapeHtml(project.version)}</div>` : ""}
    <input type="text" id="search" class="search-box" placeholder="Filter API... (Press /)" autocomplete="off">
    <div class="sidebar-title">Modules</div>
    <div id="module-links">
      ${sidebarModules}
    </div>
  </nav>

  <main id="content">
    <h1>${escapeHtml(project.title)} API Documentation</h1>
    <div class="hero-stats">
      <div class="stat-pill"><strong>${project.modules.length}</strong> Modules</div>
      <div class="stat-pill"><strong>${totalSchemas}</strong> Schemas</div>
      <div class="stat-pill"><strong>${totalServices}</strong> Services</div>
      <div class="stat-pill"><strong>${totalFunctions}</strong> Functions</div>
    </div>

    ${modulesHtml}
  </main>

  <script>
    const searchInput = document.getElementById("search");
    searchInput.addEventListener("input", (e) => {
      const q = e.target.value.toLowerCase().trim();
      const cards = document.querySelectorAll(".doc-card");
      cards.forEach((card) => {
        const name = (card.getAttribute("data-name") || "").toLowerCase();
        const text = card.textContent.toLowerCase();
        const visible = !q || name.includes(q) || text.includes(q);
        card.style.display = visible ? "" : "none";
      });
      const sections = document.querySelectorAll(".module-section");
      sections.forEach((sec) => {
        const visibleCards = sec.querySelectorAll('.doc-card:not([style*="display: none"])');
        sec.style.display = (visibleCards.length > 0 || !q) ? "" : "none";
      });
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "/" && document.activeElement !== searchInput) {
        e.preventDefault();
        searchInput.focus();
      }
    });
  </script>
</body>
</html>`;
}

export async function generateDocs(
  files: string[],
  options: DocOptions = {},
): Promise<{ outDir: string; mainFile: string; project: DocProject }> {
  const root = process.cwd();
  let title = options.title || "FunScript Project";
  let version = "";

  try {
    const pkgRaw = await fs.readFile(path.join(root, "package.json"), "utf8");
    const pkg = JSON.parse(pkgRaw);
    if (pkg.name) title = pkg.name;
    if (pkg.version) version = pkg.version;
  } catch {
    /* Package json is optional */
  }

  const modules: DocModule[] = [];
  for (const file of files) {
    try {
      const fullPath = path.resolve(root, file);
      const source = await fs.readFile(fullPath, "utf8");
      const mod = extractModuleDoc(source, fullPath, root);
      if (
        mod.schemas.length ||
        mod.services.length ||
        mod.functions.length ||
        mod.errors.length ||
        mod.bindings.length
      ) {
        modules.push(mod);
      }
    } catch {
      /* Skip unreadable files */
    }
  }

  modules.sort((a, b) => a.moduleName.localeCompare(b.moduleName));
  const project: DocProject = {
    title,
    version,
    modules,
  };

  const format = options.format || "html";
  const outDir = path.resolve(root, options.outDir || "docs/api");
  await fs.mkdir(outDir, { recursive: true });

  let mainFile = "";
  if (format === "json") {
    mainFile = path.join(outDir, "docs.json");
    await fs.writeFile(mainFile, JSON.stringify(project, null, 2), "utf8");
  } else if (format === "markdown") {
    mainFile = path.join(outDir, "api.md");
    await fs.writeFile(mainFile, renderMarkdownDoc(project), "utf8");
  } else {
    mainFile = path.join(outDir, "index.html");
    await fs.writeFile(mainFile, renderHtmlDoc(project), "utf8");
  }

  if (options.open && format === "html") {
    const plat = process.platform;
    const cmd =
      plat === "darwin" ? "open" : plat === "win32" ? "start" : "xdg-open";
    spawn(cmd, [mainFile], { detached: true, stdio: "ignore" }).unref();
  }

  return { outDir, mainFile, project };
}
