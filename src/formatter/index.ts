import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";
import {
  Program,
  TopLevelDeclaration,
  ImportDeclaration,
  ImportSpecifier,
  ExportDeclaration,
  BindingDeclaration,
  SchemaDeclaration,
  SchemaBody,
  RecordSchema,
  RecordFieldSchema,
  TaggedUnionSchema,
  VariantDeclaration,
  VariantField,
  RefinementSchema,
  TypeSignatureSchema,
  ErrorDeclaration,
  ErrorField,
  ServiceDeclaration,
  ServiceMember,
  Expression,
  PipelineExpression,
  BinaryExpression,
  UnaryExpression,
  CallExpression,
  MemberExpression,
  IndexExpression,
  RecordExpression,
  RecordEntry,
  SpreadEntry,
  FieldEntry,
  DotPathEntry,
  ShorthandEntry,
  ArrayExpression,
  FunctionExpression,
  FunctionBody,
  BlockStatement,
  Statement,
  AssignmentStatement,
  ExpressionStatement,
  MutBlockExpression,
  MatchExpression,
  MatchArm,
  Pattern,
  ConstructorPattern,
  RecordPattern,
  ArrayPattern,
  OrPattern,
  EffectBlockExpression,
  EffectStatement,
  EffectBindStatement,
  EffectDiscardStatement,
  EffectControlFlowStatement,
  WhenStatement,
  TypeNode,
  TypeReferenceNode,
  TypeParameter,
  Parameter,
  FunctionTypeNode,
  EffectTypeNode,
  RecordTypeNode,
  RecordTypeField,
  ArrayTypeNode,
  UnionTypeNode,
  Literal,
  NumberLiteral,
  StringLiteral,
  BooleanLiteral,
  Identifier,
  UpperIdentifier,
  Placeholder,
  TypedHole,
} from "../ast/types.js";

export interface FormatOptions {
  indentSize?: number;
  filename?: string;
}

export interface Comment {
  text: string;
  line: number;
  col: number;
  isTrailing: boolean;
}

export function extractComments(source: string): Comment[] {
  const comments: Comment[] = [];
  let inString = false;
  let escape = false;
  let line = 1;
  let col = 1;
  let lineHasCode = false;
  const braceStack: ("string" | "interpolation")[] = [];

  for (let i = 0; i < source.length; i++) {
    const c = source[i];

    if (c === "\n") {
      line++;
      col = 1;
      lineHasCode = false;
      continue;
    }

    if (inString) {
      if (escape) {
        escape = false;
      } else if (c === "\\") {
        escape = true;
      } else if (c === '"') {
        inString = false;
        if (braceStack.length > 0 && braceStack[braceStack.length - 1] === "string") {
          braceStack.pop();
        }
      } else if (c === "{" && !escape) {
        braceStack.push("interpolation");
        inString = false;
      }
      col++;
      continue;
    }

    if (c === '"') {
      inString = true;
      braceStack.push("string");
      lineHasCode = true;
      col++;
      continue;
    }

    if (c === "}" && braceStack.length > 0 && braceStack[braceStack.length - 1] === "interpolation") {
      braceStack.pop();
      inString = true;
      col++;
      continue;
    }

    if (c === "#") {
      let end = i;
      while (end < source.length && source[end] !== "\n" && source[end] !== "\r") {
        end++;
      }
      const rawText = source.slice(i, end).trimEnd();
      let text = rawText;
      if (rawText.startsWith("#") && !rawText.startsWith("#!") && !rawText.startsWith("##")) {
        const afterHash = rawText.slice(1);
        if (afterHash.length > 0 && !afterHash.startsWith(" ")) {
          text = "# " + afterHash;
        }
      }
      comments.push({
        text,
        line,
        col,
        isTrailing: lineHasCode,
      });
      i = end - 1;
      col += (end - i);
      continue;
    }

    if (c !== " " && c !== "\t" && c !== "\r") {
      lineHasCode = true;
    }
    col++;
  }

  return comments;
}

const PRECEDENCE: Record<string, number> = {
  "or": 1,
  "and": 2,
  "??": 3,
  "==": 4,
  "!=": 4,
  "===": 4,
  "!==": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
  "**": 7,
};

export class Formatter {
  private indentSize: number;
  private comments: Comment[];
  private leadingComments = new Map<any, Comment[]>();
  private trailingComments = new Map<number, Comment>();
  private eofComments: Comment[] = [];

  constructor(
    private source: string,
    private ast: Program,
    options?: FormatOptions
  ) {
    this.indentSize = options?.indentSize ?? 2;
    this.comments = extractComments(source);
    this.attachComments();
  }

  private attachComments(): void {
    const standaloneComments: Comment[] = [];

    for (const c of this.comments) {
      if (c.isTrailing) {
        this.trailingComments.set(c.line, c);
      } else {
        standaloneComments.push(c);
      }
    }

    for (const c of standaloneComments) {
      const target = this.findCommentTarget(this.ast, c.line);
      if (target) {
        let list = this.leadingComments.get(target);
        if (!list) {
          list = [];
          this.leadingComments.set(target, list);
        }
        list.push(c);
      } else {
        this.eofComments.push(c);
      }
    }
  }

  private findCommentTarget(node: any, commentLine: number): any {
    const children = this.getNodeChildren(node);
    if (!children || children.length === 0) {
      return null;
    }

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!child || !child.span) continue;

      if (commentLine <= child.span.start.line) {
        return child;
      }

      const inner = this.findCommentTarget(child, commentLine);
      if (inner) {
        return inner;
      }
    }

    return null;
  }

  private getNodeChildren(node: any): any[] | null {
    if (!node) return null;
    switch (node.kind) {
      case "Program":
        return node.body;
      case "ExportDeclaration":
        return [node.declaration];
      case "BindingDeclaration":
        return [node.init];
      case "SchemaDeclaration":
        return this.getNodeChildren(node.body);
      case "RecordSchema":
        return node.fields;
      case "TaggedUnionSchema":
        return node.variants;
      case "ServiceDeclaration":
        return node.members;
      case "BlockStatement":
        return [...node.statements, ...(node.finalExpression ? [node.finalExpression] : [])];
      case "EffectBlockExpression":
        return [...node.body, ...(node.finalExpression ? [node.finalExpression] : [])];
      case "MatchExpression":
        return node.arms;
      case "MatchArm":
        return [node.body];
      case "FunctionExpression":
        if (node.body.kind === "BlockStatement") {
          return [...node.body.statements, ...(node.body.finalExpression ? [node.body.finalExpression] : [])];
        }
        return [node.body];
      case "RecordExpression":
        return node.entries;
      case "PipelineExpression": {
        const steps: any[] = [];
        let curr = node;
        while (curr.kind === "PipelineExpression") {
          steps.unshift(curr.right);
          curr = curr.left;
        }
        steps.unshift(curr);
        return steps;
      }
      default:
        return null;
    }
  }

  private spaces(count: number): string {
    return " ".repeat(Math.max(0, count));
  }

  private escapeStringPart(val: string): string {
    return val
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t")
      .replace(/\{/g, "\\{");
  }

  private formatLeadingComments(node: any, indentStr: string): string {
    const comments = this.leadingComments.get(node);
    if (!comments || comments.length === 0) return "";

    const lines: string[] = [];
    for (let i = 0; i < comments.length; i++) {
      const c = comments[i];
      if (i > 0 && c.line - comments[i - 1].line > 1) {
        lines.push("");
      }
      lines.push(`${indentStr}${c.text}`);
    }

    const lastComment = comments[comments.length - 1];
    const blankAfter = node.span && node.span.start.line - lastComment.line > 1;

    return lines.join("\n") + "\n" + (blankAfter ? "\n" : "");
  }

  private getTrailingComment(line: number): string {
    const c = this.trailingComments.get(line);
    if (!c) return "";
    this.trailingComments.delete(line);
    return `  ${c.text}`;
  }

  public format(): string {
    const parts: string[] = [];

    for (let i = 0; i < this.ast.body.length; i++) {
      const decl = this.ast.body[i];
      const leading = this.formatLeadingComments(decl, "");
      const formattedDecl = this.formatTopLevelDeclaration(decl);
      const trailing = this.getTrailingComment(decl.span.end.line);
      const piece = `${leading}${formattedDecl}${trailing}`;
      parts.push(piece);
    }

    let result = "";
    for (let i = 0; i < parts.length; i++) {
      result += parts[i];
      if (i < parts.length - 1) {
        const curr = this.ast.body[i];
        const next = this.ast.body[i + 1];
        const currInner = curr.kind === "ExportDeclaration" ? curr.declaration : curr;
        const nextInner = next.kind === "ExportDeclaration" ? next.declaration : next;
        const currIsMulti = currInner.kind === "ServiceDeclaration" ||
          (currInner.kind === "SchemaDeclaration" && currInner.body.kind !== "TypeSignatureSchema") ||
          (currInner.kind === "BindingDeclaration" && currInner.init.span && currInner.init.span.end.line > currInner.init.span.start.line);
        const nextIsMulti = nextInner.kind === "ServiceDeclaration" ||
          (nextInner.kind === "SchemaDeclaration" && nextInner.body.kind !== "TypeSignatureSchema") ||
          (nextInner.kind === "BindingDeclaration" && nextInner.init.span && nextInner.init.span.end.line > nextInner.init.span.start.line);

        if (currIsMulti || nextIsMulti) {
          result += "\n\n";
        } else {
          const hasBlank = next.span.start.line - curr.span.end.line > 1;
          if (hasBlank) {
            result += "\n\n";
          } else {
            result += "\n";
          }
        }
      }
    }

    if (this.eofComments.length > 0) {
      if (result.length > 0) result += "\n\n";
      result += this.eofComments.map(c => c.text).join("\n");
    }

    return result.trimEnd() + "\n";
  }

  private formatTopLevelDeclaration(decl: TopLevelDeclaration): string {
    switch (decl.kind) {
      case "ExportDeclaration":
        return `export ${this.formatDeclaration(decl.declaration)}`;
      case "ImportDeclaration":
        return this.formatImportDeclaration(decl);
      case "SchemaDeclaration":
        return this.formatSchemaDeclaration(decl, 0);
      case "ErrorDeclaration":
        return this.formatErrorDeclaration(decl);
      case "ServiceDeclaration":
        return this.formatServiceDeclaration(decl, 0);
      case "BindingDeclaration":
        return this.formatBindingDeclaration(decl, 0);
      case "WhenStatement":
        return this.formatStatement(decl, 0);
      case "TsEscapeDeclaration":
        return `ts "${decl.code}"`;
    }
  }

  private formatDeclaration(decl: SchemaDeclaration | ErrorDeclaration | ServiceDeclaration | BindingDeclaration | WhenStatement): string {
    switch (decl.kind) {
      case "SchemaDeclaration":
        return this.formatSchemaDeclaration(decl, 0);
      case "ErrorDeclaration":
        return this.formatErrorDeclaration(decl);
      case "ServiceDeclaration":
        return this.formatServiceDeclaration(decl, 0);
      case "BindingDeclaration":
        return this.formatBindingDeclaration(decl, 0);
      case "WhenStatement":
        return this.formatStatement(decl, 0);
    }
  }

  private formatImportDeclaration(decl: ImportDeclaration): string {
    const isType = decl.isTypeOnly ? "type " : "";
    const specifiers = decl.specifiers.map(s => {
      const sType = s.isTypeOnly ? "type " : "";
      const name = s.imported.name;
      const as = s.local.name !== name ? ` as ${s.local.name}` : "";
      return `${sType}${name}${as}`;
    }).join(", ");

    const firstPart = decl.source.parts[0];
    const rawVal = firstPart && firstPart.kind === "StringRawPart" ? firstPart.value : "";
    const src = this.escapeStringPart(rawVal);
    if (decl.specifiers.length === 0) {
      return `import ${isType}{} from "${src}"`;
    }
    return `import ${isType}{ ${specifiers} } from "${src}"`;
  }

  private formatSchemaDeclaration(decl: SchemaDeclaration, indent = 0): string {
    const typeParams = decl.typeParams && decl.typeParams.length > 0
      ? `<${decl.typeParams.map(p => p.name.name).join(", ")}>`
      : "";
    const body = this.formatSchemaBody(decl.body, indent);
    const sep = body.startsWith("\n") ? " =" : " = ";
    return `schema ${decl.id.name}${typeParams}${sep}${body}`;
  }

  private formatSchemaBody(body: SchemaBody, indent = 0): string {
    switch (body.kind) {
      case "RecordSchema":
        return this.formatRecordSchema(body, indent);
      case "TaggedUnionSchema":
        return this.formatTaggedUnionSchema(body, indent);
      case "RefinementSchema":
        return `${this.formatType(body.baseType)} | ${this.formatExpression(body.refinement, indent)}`;
      case "TypeSignatureSchema":
        return this.formatType(body.signature);
    }
  }

  private formatRecordSchema(schema: RecordSchema, indent = 0): string {
    if (schema.fields.length === 0) return "{}";
    const fieldIndent = this.spaces(indent + this.indentSize);
    const closingIndent = this.spaces(indent);
    const fields = schema.fields.map(f => {
      const leading = this.formatLeadingComments(f, fieldIndent);
      const trailing = this.getTrailingComment(f.span.end.line);
      const def = f.defaultValue ? ` = ${this.formatExpression(f.defaultValue, indent + this.indentSize)}` : "";
      return `${leading}${fieldIndent}${f.name.name}: ${this.formatType(f.typeAnnotation, indent + this.indentSize)}${def}${trailing}`;
    }).join("\n");
    return `{\n${fields}\n${closingIndent}}`;
  }

  private formatTaggedUnionSchema(schema: TaggedUnionSchema, indent = 0): string {
    const variantIndent = this.spaces(indent + this.indentSize);
    const variants = schema.variants.map(v => {
      const leading = this.formatLeadingComments(v, variantIndent);
      const trailing = this.getTrailingComment(v.span.end.line);
      const fields = v.fields.length > 0
        ? `(${v.fields.map(f => `${f.name.name}: ${this.formatType(f.typeAnnotation)}`).join(", ")})`
        : "";
      return `${leading}${variantIndent}| ${v.name.name}${fields}${trailing}`;
    }).join("\n");
    return `\n${variants}`;
  }

  private formatErrorDeclaration(decl: ErrorDeclaration): string {
    const fields = decl.fields.length > 0
      ? `(${decl.fields.map(f => `${f.name.name}: ${this.formatType(f.typeAnnotation)}`).join(", ")})`
      : "";
    return `error ${decl.id.name}${fields}`;
  }

  private formatServiceDeclaration(decl: ServiceDeclaration, indent = 0): string {
    let tag = "";
    if (decl.customTag) {
      const firstPart = decl.customTag.parts[0];
      const rawVal = firstPart && firstPart.kind === "StringRawPart" ? firstPart.value : "";
      tag = ` "${this.escapeStringPart(rawVal)}"`;
    }
    const memberIndent = this.spaces(indent + this.indentSize);
    const members = decl.members.map(m => {
      const leading = this.formatLeadingComments(m, memberIndent);
      const trailing = this.getTrailingComment(m.span.end.line);
      return `${leading}${memberIndent}${m.name.name}: ${this.formatType(m.signature)}${trailing}`;
    }).join("\n");
    return `service ${decl.id.name}${tag}\n${members}`;
  }

  private formatBindingDeclaration(decl: BindingDeclaration, indent = 0): string {
    const js = decl.isJs ? "js " : "";
    const mut = decl.isMut ? "mut " : "";
    const typeAnn = decl.typeAnnotation ? `: ${this.formatType(decl.typeAnnotation)}` : "";
    const prefix = `${js}${mut}${decl.id.name}${typeAnn} =`;
    const init = this.formatBindingInit(decl, indent);
    return `${prefix}${init}`;
  }

  private formatBindingInit(decl: BindingDeclaration, indent = 0): string {
    const init = decl.init;
    if (init.kind === "FunctionExpression") {
      const typeParams = init.typeParams && init.typeParams.length > 0
        ? `<${init.typeParams.map(t => t.name.name).join(", ")}>`
        : "";
      const params = init.params.map(p => {
        return p.typeAnnotation ? `${p.name.name}: ${this.formatType(p.typeAnnotation)}` : p.name.name;
      }).join(", ");
      const ret = init.returnType ? `: ${this.formatType(init.returnType)}` : "";
      const isArrowOnly = init.params.length === 0 && !init.returnType && init.span && this.source.slice(init.span.start.offset, init.span.start.offset + 2) === "->";
      const sig = isArrowOnly ? ` ->` : ` ${typeParams}(${params})${ret} ->`;

      if (init.body.kind === "BlockStatement") {
        const body = this.formatBlockStatement(init.body, indent + this.indentSize);
        return `${sig}\n${body}`;
      } else {
        const body = this.formatExpression(init.body, indent);
        return `${sig} ${body}`;
      }
    }

    if (init.kind === "RecordExpression") {
      const isMultiline = init.entries.length > 0 &&
        (init.entries[0].span.start.line > init.span.start.line ||
         init.entries.some(e => e.span.end.line > e.span.start.line));
      if (isMultiline) {
        return ` ${this.formatRecordExpression(init, indent)}`;
      }
    }

    if (init.kind === "PipelineExpression") {
      const chain = this.unrollPipeline(init);
      if (chain.length > 2 || (chain.length === 2 && chain[0].span.end.line < chain[1].span.start.line)) {
        return `\n${this.spaces(indent + this.indentSize)}${this.formatPipelineExpression(init, indent + this.indentSize)}`;
      }
    }

    if (init.kind === "EffectBlockExpression") {
      return `\n${this.spaces(indent + this.indentSize)}${this.formatEffectBlock(init, indent + this.indentSize)}`;
    }

    if (init.kind === "MatchExpression") {
      const isSingleLine = init.arms.length > 0 && init.arms[0].span.start.line === init.span.start.line && init.arms.every(a => a.body.kind !== "BlockStatement");
      if (!isSingleLine) {
        return `\n${this.spaces(indent + this.indentSize)}${this.formatMatchExpression(init, indent + this.indentSize)}`;
      }
    }

    if (init.span.start.line > decl.span.start.line) {
      return `\n${this.spaces(indent + this.indentSize)}${this.formatExpression(init, indent + this.indentSize)}`;
    }

    return ` ${this.formatExpression(init, indent)}`;
  }

  private unrollPipeline(expr: PipelineExpression): Expression[] {
    const chain: Expression[] = [];
    let curr: Expression = expr;
    while (curr.kind === "PipelineExpression") {
      chain.unshift(curr.right);
      curr = curr.left;
    }
    chain.unshift(curr);
    return chain;
  }

  private formatPipelineExpression(expr: PipelineExpression, indent = 0): string {
    const chain = this.unrollPipeline(expr);
    const isMulti = chain.length > 2 ||
      (chain.length === 2 && (chain[0].span.end.line < chain[1].span.start.line || chain[0].kind === "EffectBlockExpression"));

    if (!isMulti) {
      return `${this.formatExpression(chain[0], indent)} |> ${this.formatExpression(chain[1], indent)}`;
    }

    const head = this.formatExpression(chain[0], indent);
    const stepIndent = this.spaces(indent);
    const steps = chain.slice(1).map(step => {
      const trailing = this.getTrailingComment(step.span.end.line);
      return `${stepIndent}|> ${this.formatExpression(step, indent)}${trailing}`;
    }).join("\n");

    return `${head}\n${steps}`;
  }

  private formatTarget(target: Identifier | import("../ast/types.js").DotPathExpression): string {
    if (target.kind === "Identifier") {
      return target.name;
    }
    return target.path.map(p => p.name).join(".");
  }

  private formatStatement(stmt: Statement, indent: number): string {
    switch (stmt.kind) {
      case "BindingDeclaration":
        return this.formatBindingDeclaration(stmt, indent);
      case "AssignmentStatement":
        return `${this.formatTarget(stmt.target)} = ${this.formatExpression(stmt.value, indent)}`;
      case "ExpressionStatement":
        return this.formatExpression(stmt.expression, indent);
      case "ReturnStatement":
        return `=> ${this.formatExpression(stmt.argument, indent)}`;
      case "WhenStatement":
        if (stmt.isEarlyReturn) {
          return `when (${this.formatExpression(stmt.condition, indent)}) => ${this.formatExpression(stmt.consequent as Expression, indent)}`;
        }
        return `when (${this.formatExpression(stmt.condition, indent)}) {\n${this.formatBlockStatement(stmt.consequent as BlockStatement, indent + this.indentSize)}\n${this.spaces(indent)}}`;
    }
  }

  private formatBlockStatement(stmt: BlockStatement, indent: number): string {
    const lines: string[] = [];
    const lineIndent = this.spaces(indent);
    const blockLeading = this.formatLeadingComments(stmt, lineIndent);
    if (blockLeading) {
      lines.push(blockLeading.trimEnd());
    }

    for (let i = 0; i < stmt.statements.length; i++) {
      const s = stmt.statements[i];
      const leading = this.formatLeadingComments(s, lineIndent);
      const trailing = this.getTrailingComment(s.span.end.line);
      lines.push(`${leading}${lineIndent}${this.formatStatement(s, indent)}${trailing}`);
      if (i < stmt.statements.length - 1) {
        const next = stmt.statements[i + 1];
        if (next.span && s.span && next.span.start.line - s.span.end.line > 1) {
          lines.push("");
        }
      }
    }

    if (stmt.finalExpression) {
      if (stmt.statements.length > 0) {
        const last = stmt.statements[stmt.statements.length - 1];
        if (stmt.finalExpression.span && last.span && stmt.finalExpression.span.start.line - last.span.end.line > 1) {
          lines.push("");
        }
      }

      const leadingFinal = this.formatLeadingComments(stmt.finalExpression, lineIndent);
      const trailingFinal = this.getTrailingComment(stmt.finalExpression.span.end.line);
      lines.push(`${leadingFinal}${lineIndent}${this.formatExpression(stmt.finalExpression, indent)}${trailingFinal}`);
    }

    return lines.join("\n");
  }

  private formatEffectBlock(expr: EffectBlockExpression, indent = 0): string {
    const stmtIndent = this.spaces(indent + this.indentSize);
    const lines: string[] = [];

    for (let i = 0; i < expr.body.length; i++) {
      const stmt = expr.body[i];
      const leading = this.formatLeadingComments(stmt, stmtIndent);
      const trailing = this.getTrailingComment(stmt.span.end.line);
      const formatted = this.formatEffectStatement(stmt, indent + this.indentSize);
      lines.push(`${leading}${stmtIndent}${formatted}${trailing}`);
      if (i < expr.body.length - 1) {
        const next = expr.body[i + 1];
        if (next.span && stmt.span && next.span.start.line - stmt.span.end.line > 1) {
          lines.push("");
        }
      }
    }

    if (expr.body.length > 0) {
      const last = expr.body[expr.body.length - 1];
      if (expr.finalExpression.span && last.span && expr.finalExpression.span.start.line - last.span.end.line > 1) {
        lines.push("");
      }
    }

    const leadingFinal = this.formatLeadingComments(expr.finalExpression, stmtIndent);
    const trailingFinal = this.getTrailingComment(expr.finalExpression.span.end.line);
    lines.push(`${leadingFinal}${stmtIndent}${this.formatExpression(expr.finalExpression, indent + this.indentSize)}${trailingFinal}`);

    return `effect\n${lines.join("\n")}`;
  }

  private formatEffectStatement(stmt: EffectStatement, indent: number): string {
    switch (stmt.kind) {
      case "EffectBindStatement":
        return `${stmt.id.name} <- ${this.formatExpression(stmt.effect, indent)}`;
      case "EffectDiscardStatement":
        return `_ <- ${this.formatExpression(stmt.effect, indent)}`;
      case "BindingDeclaration":
        return this.formatBindingDeclaration(stmt, indent);
      case "AssignmentStatement":
        return `${this.formatTarget(stmt.target)} = ${this.formatExpression(stmt.value, indent)}`;
      case "EffectControlFlowStatement":
        return this.formatExpression(stmt.statement, indent);
      case "WhenStatement":
        return this.formatStatement(stmt, indent);
    }
  }

  private getMatchArmArrow(arm: MatchArm): string {
    if (this.source && arm.span && arm.body.span) {
      const between = this.source.slice(arm.span.start.offset, arm.body.span.start.offset);
      if (between.includes("=>")) return "=>";
      if (between.includes("->")) return "->";
    }
    return "=>";
  }

  private formatMatchExpression(expr: MatchExpression, indent = 0): string {
    const isSubjectless = expr.scrutinee === undefined && !expr.isPipeline;
    const isSingleLine = expr.arms.length > 0 &&
      expr.arms[0].span.start.line === expr.span.start.line &&
      expr.arms.every(a => a.body.kind !== "BlockStatement");

    if (isSingleLine) {
      const scrutinee = expr.scrutinee ? ` ${this.formatExpression(expr.scrutinee, indent)}` : "";
      const arms = expr.arms.map(a => this.formatMatchArmInline(a, isSubjectless)).join(" ");
      return `match${scrutinee} ${arms}`;
    }

    const scrutinee = expr.scrutinee ? ` ${this.formatExpression(expr.scrutinee, indent)}` : "";
    const arms = expr.arms.map(a => this.formatMatchArm(a, indent + this.indentSize, isSubjectless)).join("\n");
    return `match${scrutinee}\n${arms}`;
  }

  private formatMatchArm(arm: MatchArm, indent: number, isSubjectless: boolean): string {
    const armIndent = this.spaces(indent);
    const leading = this.formatLeadingComments(arm, armIndent);
    const trailing = this.getTrailingComment(arm.span.end.line);
    const pat = this.formatPattern(arm.pattern, isSubjectless);
    const guard = arm.guard ? ` when ${this.formatExpression(arm.guard, indent)}` : "";
    const arrow = this.getMatchArmArrow(arm);

    if (arm.body.kind === "BlockStatement") {
      const bodyIndent = indent + this.indentSize * 2;
      const body = this.formatBlockStatement(arm.body, bodyIndent);
      return `${leading}${armIndent}| ${pat}${guard} ${arrow}\n${body}${trailing}`;
    } else {
      const body = this.formatExpression(arm.body, indent);
      return `${leading}${armIndent}| ${pat}${guard} ${arrow} ${body}${trailing}`;
    }
  }

  private formatMatchArmInline(arm: MatchArm, isSubjectless: boolean): string {
    const pat = this.formatPattern(arm.pattern, isSubjectless);
    const guard = arm.guard ? ` when ${this.formatExpression(arm.guard, 0)}` : "";
    const arrow = this.getMatchArmArrow(arm);
    const body = arm.body.kind === "BlockStatement"
      ? this.formatBlockStatement(arm.body, 0)
      : this.formatExpression(arm.body, 0);
    return `| ${pat}${guard} ${arrow} ${body}`;
  }

  private formatPattern(pat: Pattern, isSubjectless = false): string {
    switch (pat.kind) {
      case "WildcardPattern":
        return "_";
      case "LiteralPattern": {
        const rawExpr = (pat.literal as any).rawExpr;
        if (rawExpr) {
          return this.formatExpression(rawExpr, 0);
        }
        return this.formatLiteral(pat.literal);
      }
      case "VariablePattern":
        return pat.name.name;
      case "ConstructorPattern": {
        const args = pat.args.length > 0 ? `(${pat.args.map(a => this.formatPattern(a)).join(", ")})` : "";
        return `${pat.constructorName.name}${args}`;
      }
      case "RecordPattern":
        return `{ ${pat.fields.map(f => f.pattern ? `${f.key.name}: ${this.formatPattern(f.pattern)}` : f.key.name).join(", ")} }`;
      case "ArrayPattern":
        return `[${pat.elements.map(e => this.formatPattern(e)).join(", ")}]`;
      case "OrPattern":
        return pat.patterns.map(p => this.formatPattern(p)).join(" | ");
    }
  }

  private formatRecordExpression(expr: RecordExpression, indent = 0): string {
    if (expr.entries.length === 0) return "{}";

    const isMultiline = expr.entries.length > 0 &&
      (expr.entries[0].span.start.line > expr.span.start.line ||
       expr.entries.some(e => e.span.end.line > e.span.start.line));

    if (!isMultiline) {
      const entriesStr = expr.entries.map(e => this.formatRecordEntry(e, indent)).join(", ");
      return `{ ${entriesStr} }`;
    }

    const entryIndent = this.spaces(indent + this.indentSize);
    const closingIndent = this.spaces(indent);
    const lines: string[] = [];
    for (let i = 0; i < expr.entries.length; i++) {
      const e = expr.entries[i];
      const leading = this.formatLeadingComments(e, entryIndent);
      const trailing = this.getTrailingComment(e.span.end.line);
      lines.push(`${leading}${entryIndent}${this.formatRecordEntry(e, indent + this.indentSize)}${trailing}`);
      if (i < expr.entries.length - 1) {
        const next = expr.entries[i + 1];
        if (next.span && e.span && next.span.start.line - e.span.end.line > 1) {
          lines.push("");
        }
      }
    }
    return `{\n${lines.join("\n")}\n${closingIndent}}`;
  }

  private formatRecordEntry(entry: RecordEntry, indent = 0): string {
    switch (entry.kind) {
      case "SpreadEntry":
        return `...${this.formatExpression(entry.argument, indent)}`;
      case "FieldEntry":
        return `${entry.key.name}: ${this.formatExpression(entry.value, indent)}`;
      case "DotPathEntry":
        return `${entry.path.map(p => p.name).join(".")}: ${this.formatExpression(entry.value, indent)}`;
      case "ShorthandEntry":
        return entry.key.name;
    }
  }

  private formatArrayExpression(expr: ArrayExpression, indent = 0): string {
    if (expr.elements.length === 0) return "[]";

    const isMultiline = expr.elements.some(e => e.span.end.line > e.span.start.line) ||
      (expr.elements.length > 0 && expr.elements[0].span.start.line > expr.span.start.line);

    if (!isMultiline) {
      return `[${expr.elements.map(e => this.formatExpression(e, indent)).join(", ")}]`;
    }

    const elemIndent = this.spaces(indent + this.indentSize);
    const closingIndent = this.spaces(indent);
    const lines = expr.elements.map(e => `${elemIndent}${this.formatExpression(e, indent + this.indentSize)}`);
    return `[\n${lines.join(",\n")}\n${closingIndent}]`;
  }

  private formatBinaryExpression(expr: BinaryExpression, indent = 0, parentOp?: string, isRightSide?: boolean): string {
    const currentPrec = PRECEDENCE[expr.operator] ?? 0;
    const parentPrec = parentOp ? (PRECEDENCE[parentOp] ?? 0) : 0;

    let needsParens = false;
    if (parentOp) {
      if (currentPrec < parentPrec) {
        needsParens = true;
      } else if (currentPrec === parentPrec) {
        if (isRightSide && (parentOp === "-" || parentOp === "/" || parentOp === "%")) {
          needsParens = true;
        } else if (!isRightSide && parentOp === "**") {
          needsParens = true;
        }
      }
    }

    const left = this.formatBinaryOperand(expr.left, indent, expr.operator, false);
    const right = this.formatBinaryOperand(expr.right, indent, expr.operator, true);
    const res = `${left} ${expr.operator} ${right}`;
    return needsParens ? `(${res})` : res;
  }

  private formatBinaryOperand(expr: Expression, indent: number, parentOp: string, isRightSide: boolean): string {
    if (expr.kind === "BinaryExpression") {
      return this.formatBinaryExpression(expr, indent, parentOp, isRightSide);
    }
    if (expr.kind === "PipelineExpression") {
      return `(${this.formatPipelineExpression(expr, indent)})`;
    }
    return this.formatExpression(expr, indent);
  }

  private formatUnaryExpression(expr: UnaryExpression, indent = 0): string {
    const op = expr.operator === "not" ? "not " : "-";
    let arg: string;
    if (expr.argument.kind === "BinaryExpression" || expr.argument.kind === "PipelineExpression") {
      arg = `(${this.formatExpression(expr.argument, indent)})`;
    } else {
      arg = this.formatExpression(expr.argument, indent);
    }
    return `${op}${arg}`;
  }

  private formatCallExpression(expr: CallExpression, indent = 0): string {
    let callee: string;
    if (expr.callee.kind === "FunctionExpression") {
      callee = `(${this.formatExpression(expr.callee, indent)})`;
    } else {
      callee = this.formatExpression(expr.callee, indent);
    }

    if (expr.args.length === 0) return `${callee}()`;

    const lastArg = expr.args[expr.args.length - 1];
    const isMultilineBlock = lastArg.kind === "FunctionExpression" &&
      (lastArg.body.kind === "BlockStatement" || lastArg.body.kind === "MatchExpression");

    if (isMultilineBlock) {
      if (expr.args.length === 1) {
        return `${callee}(${this.formatExpression(lastArg, indent)}\n${this.spaces(indent)})`;
      }
      const otherArgs = expr.args.slice(0, -1).map(a => this.formatExpression(a, indent)).join(", ");
      return `${callee}(${otherArgs}, ${this.formatExpression(lastArg, indent)}\n${this.spaces(indent)})`;
    }

    const args = expr.args.map(a => this.formatExpression(a, indent)).join(", ");
    return `${callee}(${args})`;
  }

  private formatExpression(expr: Expression, indent = 0): string {
    switch (expr.kind) {
      case "PipelineExpression":
        return this.formatPipelineExpression(expr, indent);
      case "BinaryExpression":
        return this.formatBinaryExpression(expr, indent);
      case "UnaryExpression":
        return this.formatUnaryExpression(expr, indent);
      case "CallExpression":
        return this.formatCallExpression(expr, indent);
      case "MemberExpression":
        return `${this.formatExpression(expr.object, indent)}.${expr.property.name}`;
      case "IndexExpression":
        return `${this.formatExpression(expr.object, indent)}[${this.formatExpression(expr.index, indent)}]`;
      case "RecordExpression":
        return this.formatRecordExpression(expr, indent);
      case "ArrayExpression":
        return this.formatArrayExpression(expr, indent);
      case "FunctionExpression":
        return this.formatFunctionExpression(expr, indent);
      case "MutBlockExpression":
        return `mut (${expr.draftParam.name}) ->\n${this.formatFunctionBody(expr.body, indent + this.indentSize)}`;
      case "MatchExpression":
        return this.formatMatchExpression(expr, indent);
      case "EffectBlockExpression":
        return this.formatEffectBlock(expr, indent);
      case "TypedHole":
        return expr.label ? `??? "${this.escapeStringPart(expr.label)}"` : "???";
      case "Placeholder":
        return "_";
      case "NumberLiteral":
        return expr.raw ?? expr.value.toString();
      case "BooleanLiteral":
        return expr.value ? "true" : "false";
      case "StringLiteral":
        return this.formatStringLiteral(expr);
      case "Identifier":
      case "UpperIdentifier":
        return expr.name;
      case "JSXElement":
      case "JSXSelfClosingElement":
        return this.source.slice(expr.span.start.offset, expr.span.end.offset);
      case "JsExpression":
        return `js ${this.formatExpression(expr.expression, indent)}`;
      case "TsEscapeExpression":
        return `ts "${expr.code}"`;
    }
  }

  private formatFunctionBody(body: FunctionBody, indent: number): string {
    if (body.kind === "BlockStatement") {
      return this.formatBlockStatement(body, indent);
    }
    return `${this.spaces(indent)}${this.formatExpression(body, indent)}`;
  }

  private formatStringLiteral(str: StringLiteral): string {
    let result = '"';
    for (const part of str.parts) {
      if (part.kind === "StringRawPart") {
        result += this.escapeStringPart(part.value);
      } else {
        result += `{${this.formatExpression(part.expression, 0)}}`;
      }
    }
    result += '"';
    return result;
  }

  private formatLiteral(lit: Literal): string {
    switch (lit.kind) {
      case "NumberLiteral":
        return lit.raw ?? lit.value.toString();
      case "BooleanLiteral":
        return lit.value ? "true" : "false";
      case "StringLiteral":
        return this.formatStringLiteral(lit);
    }
  }

  private formatFunctionExpression(expr: FunctionExpression, indent = 0): string {
    const typeParams = expr.typeParams && expr.typeParams.length > 0
      ? `<${expr.typeParams.map(t => t.name.name).join(", ")}>`
      : "";
    const params = expr.params.map(p => {
      return p.typeAnnotation ? `${p.name.name}: ${this.formatType(p.typeAnnotation)}` : p.name.name;
    }).join(", ");
    const ret = expr.returnType ? `: ${this.formatType(expr.returnType)}` : "";
    const isArrowOnly = expr.params.length === 0 && !expr.returnType && expr.span && this.source.slice(expr.span.start.offset, expr.span.start.offset + 2) === "->";
    const sig = isArrowOnly ? `->` : `${typeParams}(${params})${ret} ->`;

    if (expr.body.kind === "BlockStatement") {
      const body = this.formatBlockStatement(expr.body, indent + this.indentSize);
      return `${sig}\n${body}`;
    } else {
      const body = this.formatExpression(expr.body, indent);
      return `${sig} ${body}`;
    }
  }

  public formatType(node: TypeNode, indent = 0): string {
    switch (node.kind) {
      case "TypeReferenceNode": {
        const typeArgs = node.typeArgs && node.typeArgs.length > 0
          ? `<${node.typeArgs.map(t => this.formatType(t, indent)).join(", ")}>`
          : "";
        return `${node.name.name[0].toUpperCase()}${node.name.name.slice(1)}${typeArgs}`;
      }
      case "FunctionTypeNode": {
        const params = node.params.map(p => {
          const typeStr = p.typeAnnotation ? this.formatType(p.typeAnnotation, indent) : "Unknown";
          return p.name ? `${p.name.name}: ${typeStr}` : typeStr;
        }).join(", ");
        return `(${params}) -> ${this.formatType(node.returnType, indent)}`;
      }
      case "EffectTypeNode": {
        const args = [this.formatType(node.success, indent)];
        if (node.error) {
          args.push(this.formatType(node.error, indent));
          if (node.requirements) {
            args.push(this.formatType(node.requirements, indent));
          }
        }
        return `Effect<${args.join(", ")}>`;
      }
      case "RecordTypeNode": {
        if (node.fields.length === 0) return "{}";
        const isMultiline = node.span.start.line !== node.span.end.line;
        if (isMultiline) {
          const fieldIndent = this.spaces(indent + this.indentSize);
          const closingIndent = this.spaces(indent);
          const fields = node.fields.map(f => `${fieldIndent}${f.name.name}: ${this.formatType(f.typeAnnotation, indent + this.indentSize)}`).join("\n");
          return `{\n${fields}\n${closingIndent}}`;
        }
        const fields = node.fields.map(f => `${f.name.name}: ${this.formatType(f.typeAnnotation, indent)}`).join(", ");
        return `{ ${fields} }`;
      }
      case "ArrayTypeNode":
        return `Array<${this.formatType(node.elementType, indent)}>`;
      case "UnionTypeNode":
        return node.types.map(t => this.formatType(t, indent)).join(" | ");
      case "TsEscapeTypeNode":
        return `ts "${node.code}"`;
    }
  }
}

export function format(source: string, options?: FormatOptions): string {
  const filename = options?.filename ?? "<anonymous>";
  const lexer = new Lexer(source, filename);
  const tokens = lexer.tokenize();
  const parser = new Parser(tokens, filename);
  const ast = parser.parse();
  const formatter = new Formatter(source, ast, options);
  return formatter.format();
}

export function checkFormat(source: string, options?: FormatOptions): { isFormatted: boolean; formatted: string } {
  const formatted = format(source, options);
  return {
    isFormatted: formatted === source,
    formatted,
  };
}
