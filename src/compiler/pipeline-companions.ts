import ts from "typescript";
import {
  type BindingTarget,
  type CallExpression,
  type Expression,
  type FunctionExpression,
  type Pattern,
  type PipelineExpression,
  type Program,
  type Span,
} from "../ast/types.js";
import {
  type StageResolution,
  COMPARISON_METHOD_MAP,
  ES_TOOLKIT_MATH_COLLECTION,
  ES_TOOLKIT_MATH_DATA_LAST,
  ES_TOOLKIT_METHODS,
  ES_TOOLKIT_STRING_METHODS,
  ES_TOOLKIT_TIMING_DATA_LAST,
  Emitter,
  PipelineResolutionError,
} from "../emitter/emitter.js";
import {
  DURATION_COMPANION_METHODS,
  STRING_COMPANION_METHODS,
} from "../emitter/pipeline-resolution.js";
import {
  type PipelineCompanionModule,
  PIPELINE_COMPANION_CATALOG,
  pipelineCompanionCandidates,
} from "../emitter/pipeline-catalog.js";
import { FunScriptError } from "../errors.js";
import { walkAst } from "../ast/walk.js";
import { type TypeScriptCompilationContext } from "./typescript-context.js";

function addPatternNames(pat: Pattern, names: Set<string>): void {
  if (pat.kind === "VariablePattern") names.add(pat.name.name);
  else if (pat.kind === "RecordPattern") {
    for (const f of pat.fields) {
      if (f.pattern) addPatternNames(f.pattern, names);
      else names.add(f.key.name);
    }
  } else if (pat.kind === "ArrayPattern") {
    for (const el of pat.elements) addPatternNames(el, names);
  } else if (pat.kind === "RestPattern") {
    addPatternNames(pat.argument, names);
  }
}

function addBindingNames(target: BindingTarget, names: Set<string>): void {
  if (target.kind === "Identifier" || target.kind === "UpperIdentifier") {
    names.add(target.name);
  } else if (target.kind === "RecordPattern") {
    for (const f of target.fields) {
      if (f.pattern) addPatternNames(f.pattern, names);
      else names.add(f.key.name);
    }
  } else if (target.kind === "ArrayPattern") {
    for (const el of target.elements) addPatternNames(el, names);
  }
}

export interface PipelineCompanionMap extends ReadonlyMap<
  number,
  PipelineCompanionModule
> {
  readonly pipelineCompanions: ReadonlyMap<number, PipelineCompanionModule>;
  readonly stageResolutions: ReadonlyMap<number, StageResolution>;
  readonly stageInputCompanions: ReadonlyMap<number, string>;
  readonly bareStageResolutions: ReadonlyMap<number, StageResolution>;
  readonly directCallResolutions: ReadonlyMap<number, StageResolution>;
}

function unrollPipeline(expr: PipelineExpression): Expression[] {
  const chain: Expression[] = [];
  let curr: Expression = expr;
  while (curr.kind === "PipelineExpression") {
    chain.unshift(curr.right);
    curr = curr.left;
  }
  chain.unshift(curr);
  return chain;
}

function collectPipelines(
  node: unknown,
  pipelines: PipelineExpression[] = [],
): PipelineExpression[] {
  if (!node || typeof node !== "object") return pipelines;
  const n = node as Record<string, unknown>;
  if (n.kind === "PipelineExpression") {
    const pipeNode = n as unknown as PipelineExpression;
    pipelines.push(pipeNode);
    let curr = pipeNode;
    while (curr.kind === "PipelineExpression") {
      collectPipelines(curr.right, pipelines);
      curr = curr.left as PipelineExpression;
    }
    collectPipelines(curr, pipelines);
    return pipelines;
  }
  for (const key of Object.keys(n)) {
    if (key === "span") continue;
    const child = n[key];
    if (Array.isArray(child)) {
      for (const item of child) collectPipelines(item, pipelines);
    } else if (child && typeof child === "object") {
      collectPipelines(child, pipelines);
    }
  }
  return pipelines;
}

function collectDirectCalls(
  node: unknown,
  inPipeline = false,
  calls: CallExpression[] = [],
): CallExpression[] {
  if (!node || typeof node !== "object") return calls;
  const n = node as Record<string, unknown>;
  if (n.kind === "PipelineExpression") {
    let curr = n as unknown as PipelineExpression;
    const stages: Expression[] = [];
    while (curr.kind === "PipelineExpression") {
      stages.unshift(curr.right);
      curr = curr.left as PipelineExpression;
    }
    stages.unshift(curr);
    collectDirectCalls(stages[0], inPipeline, calls);
    for (let i = 1; i < stages.length; i++) {
      collectDirectCalls(stages[i], true, calls);
    }
    return calls;
  }
  if (n.kind === "CallExpression") {
    const callNode = n as unknown as CallExpression;
    if (!inPipeline) calls.push(callNode);
    collectDirectCalls(callNode.callee, inPipeline, calls);
    for (const arg of callNode.args) collectDirectCalls(arg, inPipeline, calls);
    return calls;
  }
  for (const key of Object.keys(n)) {
    const child = n[key];
    if (Array.isArray(child)) {
      for (const item of child) collectDirectCalls(item, inPipeline, calls);
    } else if (child && typeof child === "object") {
      collectDirectCalls(child, inPipeline, calls);
    }
  }
  return calls;
}

/**
 * Finds the source and stage types of every pipeline and direct comparison call
 * using TypeScript's type checker before final emission.
 */
export function inferPipelineCompanions(
  ast: Program,
  context: TypeScriptCompilationContext,
  importedRecordFunctions?: ReadonlyMap<string, ReadonlySet<number>>,
  importedRecordContracts?: ReadonlyMap<
    string,
    import("../ast/types.js").RecordTypeNode
  >,
  importedGenericDataSchemas?: ReadonlyMap<string, number>,
  importedIdentitySchemas?: ReadonlySet<string>,
  importedDataSchemas?: ReadonlySet<string>,
  tolerateUnresolvedStages = false,
): PipelineCompanionMap {
  const schemaNames = new Set<string>();
  const localBindings = new Set<string>();

  for (const decl of ast.body) {
    if (decl.kind === "SchemaDeclaration") {
      schemaNames.add(decl.id.name);
    } else if (
      decl.kind === "ExportDeclaration" &&
      decl.declaration.kind === "SchemaDeclaration"
    ) {
      schemaNames.add(decl.declaration.id.name);
    } else if (decl.kind === "BindingDeclaration") {
      addBindingNames(decl.id, localBindings);
    } else if (
      decl.kind === "ExportDeclaration" &&
      decl.declaration.kind === "BindingDeclaration"
    ) {
      addBindingNames(decl.declaration.id, localBindings);
    } else if (decl.kind === "ImportDeclaration") {
      for (const spec of decl.specifiers) {
        localBindings.add(spec.local.name);
      }
    }
  }

  const marked = new Emitter(ast, undefined, {
    allowAmbiguousPipeline: true,
    markPipelineSources: true,
    importedRecordFunctions,
    importedRecordContracts,
    importedGenericDataSchemas,
    importedIdentitySchemas,
    importedDataSchemas,
  }).emit();

  const emptyResult = new Map<number, PipelineCompanionModule>() as Map<
    number,
    PipelineCompanionModule
  > & {
    pipelineCompanions: ReadonlyMap<number, PipelineCompanionModule>;
    stageResolutions: ReadonlyMap<number, StageResolution>;
    stageInputCompanions: ReadonlyMap<number, string>;
    bareStageResolutions: ReadonlyMap<number, StageResolution>;
    directCallResolutions: ReadonlyMap<number, StageResolution>;
  };
  emptyResult.pipelineCompanions = emptyResult;
  emptyResult.stageResolutions = new Map();
  emptyResult.stageInputCompanions = new Map();
  emptyResult.bareStageResolutions = new Map();
  emptyResult.directCallResolutions = new Map();

  if (
    !marked.includes("__funscriptPipelineSource(") &&
    !marked.includes("__funscriptDirectCall(")
  ) {
    return emptyResult;
  }

  // Bare stages are selected from the input type below, so they do not need
  // every possible companion namespace in scope. Rewrite Effect's barrel
  // imports in the checker-only source to module subpaths; loading `effect`
  // pulls its entire export graph into the TypeScript program.
  const checkerMarked = marked.replace(
    /import\s*\{([\s\S]*?)\}\s*from\s*(["'])effect\2\s*;?/g,
    (_match, bindings: string) => {
      const namespaces: string[] = [];
      const remaining: string[] = [];
      for (const binding of bindings
        .split(",")
        .map((item: string) => item.trim())
        .filter(Boolean)) {
        const parsed =
          /^(type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(
            binding,
          );
        if (!parsed || !/^[A-Z]/.test(parsed[2])) {
          remaining.push(binding);
          continue;
        }
        const [, typeOnly, imported, local = imported] = parsed;
        namespaces.push(
          `import ${typeOnly ?? ""}* as ${local} from "effect/${imported}";`,
        );
      }
      if (remaining.length)
        namespaces.push(`import { ${remaining.join(", ")} } from "effect";`);
      return namespaces.join("\n");
    },
  );
  const source = `declare const decode: any;\nconst __funscriptPipelineSource = <T,>(_id: number, value: T): T => value;\nconst __funscriptPipelineStageInput = <T,>(_id: number, value: T): T => value;\nconst __funscriptDirectCall = <T,>(_id: number, value: T): T => value;\n${checkerMarked}`;
  const checked = context.check(source);
  if (!checked) return emptyResult;
  const { sourceFile, checker } = checked;

  const companions = new Map<number, PipelineCompanionModule>();
  const stageResolutions = new Map<number, StageResolution>();
  const stageInputCompanions = new Map<number, string>();
  const bareStageResolutions = new Map<number, StageResolution>();
  const directCallResolutions = new Map<number, StageResolution>();

  const isSchemaType = (type: ts.Type): boolean => {
    if (type.getProperty("ast") && type.getProperty("Type")) return true;
    const printed = checker.typeToString(type);
    return /^Schema(?:<|$)/.test(printed) || /^Struct(?:<|$)/.test(printed);
  };

  const isDateTimeType = (type: ts.Type): boolean => {
    if (
      type.flags &
      (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)
    )
      return false;
    const name = type.aliasSymbol?.getName() ?? type.symbol?.getName();
    if (
      name === "DateTime" ||
      name === "Utc" ||
      name === "Zoned" ||
      name === "TimeZone"
    )
      return true;
    const printed = checker.typeToString(type);
    if (/^DateTime(?:<|$)/.test(printed) || /^Utc(?:<|$)/.test(printed))
      return true;
    const decl = type.symbol?.declarations?.[0];
    const fileName = decl?.getSourceFile()?.fileName ?? "";
    return /DateTime(?:\.d)?\.ts$/.test(fileName);
  };

  const companionForType = (type: ts.Type): string | undefined => {
    if (type.aliasSymbol?.getName() === "Option") return "Option";
    if (type.aliasSymbol?.getName() === "Result") return "Result";
    if (type.isUnion()) {
      const tag = checker.getPropertyOfType(type, "_tag");
      if (tag) {
        const tagType = checker.getTypeOfSymbolAtLocation(tag, sourceFile);
        const tagNames = new Set(
          (tagType.isUnion() ? tagType.types : [tagType]).flatMap((member) =>
            member.flags & ts.TypeFlags.StringLiteral
              ? [String((member as ts.StringLiteralType).value)]
              : [],
          ),
        );
        if (tagNames.has("None") && tagNames.has("Some") && tagNames.size === 2)
          return "Option";
        if (
          tagNames.has("Success") &&
          tagNames.has("Failure") &&
          tagNames.size === 2
        )
          return "Result";
      }
      const members = type.types.map(companionForType);
      const first = members[0];
      return first && members.every((member) => member === first)
        ? first
        : undefined;
    }
    const printed = checker.typeToString(type);
    if (/^Option(?:<|$)/.test(printed)) return "Option";
    if (/^Result(?:<|$)/.test(printed)) return "Result";
    if (/^Chunk(?:<|$)/.test(printed)) return "Chunk";
    if (/^Effect(?:<|$)/.test(printed)) return "Effect";
    if (/^Schedule(?:<|$)/.test(printed)) return "Schedule";
    if (/^Layer(?:<|$)/.test(printed)) return "Layer";
    if (/^Stream(?:<|$)/.test(printed)) return "Stream";
    if (/^Schema(?:<|$)/.test(printed) || isSchemaType(type)) return "Schema";
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
      return undefined;
    if (checker.isArrayType(type) || checker.isTupleType(type)) return "Array";
    if (type.flags & ts.TypeFlags.NumberLike) return "Number";
    if (type.flags & ts.TypeFlags.StringLike) return "String";
    if (type.flags & ts.TypeFlags.BooleanLike) return "Boolean";
    if (isDateTimeType(type)) return "DateTime";

    const symbol = type.aliasSymbol ?? type.getSymbol();
    const symName = symbol?.getName();
    if (symName && !symName.startsWith("__")) {
      return symName;
    }
    return undefined;
  };

  const pipelineSourceNodes = new Map<number, ts.CallExpression>();
  const pipelineStageInputNodes = new Map<number, ts.CallExpression>();
  const directCallNodes = new Map<number, ts.CallExpression>();

  // Some curried Effect APIs have TypeScript signatures whose first stage can
  // infer `never` when the predicate callback is typed before the receiver is
  // applied (for example, `Array.filter(predicate)(array)`). Preserve the
  // companion we already know from the pipeline initializer for later uses of
  // that local binding instead of losing it to the checker’s intermediate type.
  const pipelineBindingNames = new Map<
    number,
    { name: string; scopeId: number; isAssignment: boolean }
  >();
  const scopeParent = new Map<number, number>();
  const scopeDeclaredNames = new Map<number, Set<string>>();
  const pipelineScopeIds = new Map<number, number>();
  const bindingCompanions = new Map<
    number,
    Map<string, PipelineCompanionModule>
  >();
  const pipelineScopeBindings = new Map<number, Set<string>>();
  let nextScopeId = 1;

  const isShadowed = (offset: number, name: string): boolean =>
    localBindings.has(name) ||
    Boolean(pipelineScopeBindings.get(offset)?.has(name));

  const immediateBlockBindings = (
    node: Record<string, unknown>,
  ): Set<string> => {
    const names = new Set<string>();
    const visit = (cur: unknown): void => {
      if (!cur || typeof cur !== "object") return;
      if (Array.isArray(cur)) {
        cur.forEach(visit);
        return;
      }
      const c = cur as Record<string, unknown>;
      if (
        c !== node &&
        (c.kind === "FunctionExpression" ||
          c.kind === "BlockStatement" ||
          c.kind === "EffectBlockExpression" ||
          c.kind === "MatchArm")
      ) {
        return;
      }
      if (c.kind === "BindingDeclaration") {
        addBindingNames(c.id as BindingTarget, names);
      }
      for (const [k, v] of Object.entries(c)) {
        if (k !== "span") visit(v);
      }
    };
    if (node.kind === "MatchArm" && node.pattern) {
      addPatternNames(node.pattern as Pattern, names);
    }
    visit(node);
    return names;
  };

  const functionBindings = (fn: FunctionExpression): Set<string> => {
    const names = new Set<string>();
    for (const param of fn.params ?? []) addBindingNames(param.name, names);
    walkAst(fn.body, (node) => {
      if (
        node !== (fn.body as unknown as Record<string, unknown>) &&
        (node.kind === "FunctionExpression" ||
          node.kind === "BlockStatement" ||
          node.kind === "EffectBlockExpression" ||
          node.kind === "MatchArm")
      ) {
        return false;
      }
      if (node.kind === "BindingDeclaration") {
        addBindingNames(node.id as BindingTarget, names);
      }
    });
    return names;
  };
  scopeDeclaredNames.set(0, new Set(localBindings));

  const collectPipelineScopes = (
    node: unknown,
    inherited: ReadonlySet<string> = new Set(),
    currentScopeId = 0,
  ): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((child) =>
        collectPipelineScopes(child, inherited, currentScopeId),
      );
      return;
    }
    const n = node as Record<string, unknown>;
    let scope = inherited;
    let nextScope = currentScopeId;
    if (n.kind === "FunctionExpression") {
      nextScope = nextScopeId++;
      scopeParent.set(nextScope, currentScopeId);
      const declared = functionBindings(n as unknown as FunctionExpression);
      scopeDeclaredNames.set(nextScope, declared);
      scope = new Set([...inherited, ...declared]);
    } else if (
      n.kind === "BlockStatement" ||
      n.kind === "EffectBlockExpression" ||
      n.kind === "MatchArm"
    ) {
      nextScope = nextScopeId++;
      scopeParent.set(nextScope, currentScopeId);
      const declared = immediateBlockBindings(n);
      scopeDeclaredNames.set(nextScope, declared);
      scope = new Set([...inherited, ...declared]);
    }

    if (
      n.kind === "BindingDeclaration" &&
      (n.id as { kind?: string; name?: string })?.kind === "Identifier" &&
      (n.init as { kind?: string; span?: Span })?.kind === "PipelineExpression"
    ) {
      pipelineBindingNames.set((n.init as { span: Span }).span.start.offset, {
        name: (n.id as { name: string }).name,
        scopeId: nextScope,
        isAssignment: false,
      });
    } else if (
      n.kind === "AssignmentStatement" &&
      (n.target as { kind?: string; name?: string })?.kind === "Identifier" &&
      (n.value as { kind?: string; span?: Span })?.kind === "PipelineExpression"
    ) {
      pipelineBindingNames.set((n.value as { span: Span }).span.start.offset, {
        name: (n.target as { name: string }).name,
        scopeId: nextScope,
        isAssignment: true,
      });
    }

    if (n.kind === "PipelineExpression") {
      pipelineScopeIds.set(
        (n as unknown as PipelineExpression).span.start.offset,
        nextScope,
      );
      for (const stage of unrollPipeline(
        n as unknown as PipelineExpression,
      ).slice(1)) {
        const names =
          pipelineScopeBindings.get(stage.span.start.offset) ??
          new Set<string>();
        for (const name of scope) names.add(name);
        pipelineScopeBindings.set(stage.span.start.offset, names);
      }
    } else if (n.kind === "CallExpression") {
      const offset = (n as unknown as CallExpression).span.start.offset;
      const names = pipelineScopeBindings.get(offset) ?? new Set<string>();
      for (const name of scope) names.add(name);
      pipelineScopeBindings.set(offset, names);
    }
    for (const [key, child] of Object.entries(n)) {
      if (key === "span") continue;
      if (Array.isArray(child))
        child.forEach((item) => collectPipelineScopes(item, scope, nextScope));
      else if (child && typeof child === "object")
        collectPipelineScopes(child, scope, nextScope);
    }
  };
  collectPipelineScopes(ast, new Set(localBindings), 0);

  const lookupBindingCompanion = (
    startScopeId: number,
    name: string,
  ): PipelineCompanionModule | undefined => {
    let sid: number | undefined = startScopeId;
    while (sid !== undefined) {
      const map = bindingCompanions.get(sid);
      if (map?.has(name)) return map.get(name);
      if (scopeDeclaredNames.get(sid)?.has(name)) return undefined;
      sid = scopeParent.get(sid);
    }
    return undefined;
  };

  const visitNodes = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (
        node.expression.text === "__funscriptPipelineSource" &&
        node.arguments.length === 2 &&
        ts.isNumericLiteral(node.arguments[0])
      ) {
        pipelineSourceNodes.set(Number(node.arguments[0].text), node);
      } else if (
        node.expression.text === "__funscriptPipelineStageInput" &&
        node.arguments.length === 2 &&
        ts.isNumericLiteral(node.arguments[0])
      ) {
        pipelineStageInputNodes.set(Number(node.arguments[0].text), node);
      } else if (
        node.expression.text === "__funscriptDirectCall" &&
        node.arguments.length === 2 &&
        ts.isNumericLiteral(node.arguments[0])
      ) {
        directCallNodes.set(Number(node.arguments[0].text), node);
      }
    }
    ts.forEachChild(node, visitNodes);
  };
  visitNodes(sourceFile);

  // 1. Process pipelines stage-by-stage
  const pipelines = collectPipelines(ast);
  for (const pipeline of pipelines) {
    const stages = unrollPipeline(pipeline);
    const s0 = stages[0];
    const sourceNode = pipelineSourceNodes.get(s0.span.start.offset);
    if (!sourceNode) continue;

    let currentType = checker.getTypeAtLocation(sourceNode.arguments[1]);
    let currentCompanion = companionForType(currentType);
    if (
      s0.kind === "Identifier" &&
      !currentCompanion &&
      (currentType.flags &
        (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) !==
        0
    ) {
      const pipeScopeId = pipelineScopeIds.get(pipeline.span.start.offset) ?? 0;
      currentCompanion = lookupBindingCompanion(pipeScopeId, s0.name);
    }

    // Schema constructors such as Schema.String are values whose inferred
    // TypeScript type is the decoded value (string), not the schema module.
    // Preserve the syntactic proof so schema combinators can resolve.
    if (
      s0.kind === "MemberExpression" &&
      s0.object.kind === "UpperIdentifier" &&
      s0.object.name === "Schema"
    ) {
      currentCompanion = "Schema";
    }

    if (!currentCompanion && ts.isCallExpression(sourceNode.parent)) {
      for (const stage of sourceNode.parent.arguments.slice(1)) {
        if (
          ts.isCallExpression(stage) &&
          ((ts.isIdentifier(stage.expression) &&
            stage.expression.text === "decode") ||
            (ts.isPropertyAccessExpression(stage.expression) &&
              (stage.expression.name.text === "decode" ||
                stage.expression.name.text === "decodeUnknown"))) &&
          stage.arguments.length >= 1
        ) {
          const targetArg = stage.arguments[0];
          if (
            (ts.isIdentifier(targetArg) && schemaNames.has(targetArg.text)) ||
            isSchemaType(checker.getTypeAtLocation(targetArg))
          ) {
            currentCompanion = "Schema";
            break;
          }
        }
      }
    }

    if (currentCompanion && currentCompanion in PIPELINE_COMPANION_CATALOG) {
      companions.set(
        s0.span.start.offset,
        currentCompanion as PipelineCompanionModule,
      );
    }

    // Resolve subsequent stages
    for (let i = 1; i < stages.length; i++) {
      const stage = stages[i];
      const stageInputNode = pipelineStageInputNodes.get(
        stage.span.start.offset,
      );
      if (stageInputNode) {
        const stageInputType = checker.getTypeAtLocation(
          stageInputNode.arguments[1],
        );
        // The wrapper used to expose the stage input to TypeScript can lose
        // the concrete type at the first pipe boundary (Effect.pipe's
        // overloads may infer `any`). Preserve the type we already tracked
        // from the pipeline source or preceding stage in that case.
        currentCompanion = companionForType(stageInputType) ?? currentCompanion;
        currentType =
          stageInputType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)
            ? currentType
            : stageInputType;
        stageInputCompanions.set(
          stage.span.start.offset,
          currentCompanion ?? "Unknown",
        );
      } else if (currentCompanion)
        stageInputCompanions.set(stage.span.start.offset, currentCompanion);
      let fnName: string | undefined;
      let isExplicit = false;
      let explicitModule: string | undefined;

      if (stage.kind === "Identifier" || stage.kind === "UpperIdentifier") {
        fnName = stage.name;
      } else if (
        stage.kind === "CallExpression" &&
        (stage.callee.kind === "Identifier" ||
          stage.callee.kind === "UpperIdentifier")
      ) {
        fnName = stage.callee.name;
      } else if (
        stage.kind === "CallExpression" &&
        stage.callee.kind === "MemberExpression" &&
        (stage.callee.object.kind === "UpperIdentifier" ||
          stage.callee.object.kind === "Identifier")
      ) {
        explicitModule = stage.callee.object.name;
        fnName = stage.callee.property.name;
        isExplicit = true;
      } else if (
        stage.kind === "MemberExpression" &&
        (stage.object.kind === "UpperIdentifier" ||
          stage.object.kind === "Identifier")
      ) {
        explicitModule = stage.object.name;
        fnName = stage.property.name;
        isExplicit = true;
      }

      if (
        !isExplicit &&
        currentCompanion === "Effect" &&
        fnName &&
        !isShadowed(stage.span.start.offset, fnName) &&
        (fnName === "catchAll" || fnName === "fork")
      ) {
        const replacement = fnName === "catchAll" ? "catch" : "forkChild";
        throw new PipelineResolutionError(
          `${fnName} was removed; use ${replacement} instead.`,
          stage.span,
        );
      }

      if (isExplicit && explicitModule) {
        stageResolutions.set(stage.span.start.offset, {
          module: explicitModule,
          method: fnName,
        });
        if (
          fnName &&
          !isShadowed(stage.span.start.offset, fnName) &&
          currentCompanion === explicitModule &&
          PIPELINE_COMPANION_CATALOG[
            currentCompanion as PipelineCompanionModule
          ]?.includes(fnName)
        ) {
          bareStageResolutions.set(stage.span.start.offset, {
            module: currentCompanion,
            method: fnName,
          });
        }
        const sym = checker.resolveName(
          explicitModule,
          sourceFile,
          ts.SymbolFlags.Value | ts.SymbolFlags.Namespace,
          false,
        );
        if (sym && fnName) {
          const symType = checker.getTypeOfSymbolAtLocation(sym, sourceFile);
          const prop =
            checker.getPropertyOfType(symType, fnName) ??
            sym.exports?.get(ts.escapeLeadingUnderscores(fnName));
          if (prop) {
            const propType = checker.getTypeOfSymbolAtLocation(
              prop,
              sourceFile,
            );
            let ret = propType.getCallSignatures()[0]?.getReturnType();
            if (ret && ret.getCallSignatures().length > 0) {
              ret = ret.getCallSignatures()[0].getReturnType();
            }
            if (ret) {
              currentType = ret;
              currentCompanion = companionForType(ret);
            }
          }
        }
        continue;
      }

      if (!fnName) continue;

      // `js`, `runPromise`, and `runSync` are language pipeline runners handled directly by the emitter;
      // their input is intentionally an Effect, not a companion operation.
      // Built-in codec helpers (decodeJson, encodeJson) are handled directly by emitter.
      if (
        fnName === "js" ||
        fnName === "runPromise" ||
        fnName === "runSync" ||
        fnName === "decodeJson" ||
        fnName === "decodeJsonSync" ||
        fnName === "encodeJson" ||
        fnName === "encodeJsonSync"
      )
        continue;

      // User scope wins: local bindings and explicit imports take precedence
      // over type-directed companion dispatch.
      if (isShadowed(stage.span.start.offset, fnName)) continue;

      // 0. Universal 'dbg' stage: inspects value in place without altering companion or type
      if (fnName === "dbg") continue;

      // 1. Comparison operations (lessThan, greaterThan, between, etc.)
      if (fnName in COMPARISON_METHOD_MAP) {
        const method = COMPARISON_METHOD_MAP[fnName];
        if (
          currentCompanion === "Number" ||
          Boolean(currentType.flags & ts.TypeFlags.NumberLike)
        ) {
          stageResolutions.set(stage.span.start.offset, {
            module: "Number",
            method,
            isComparison: true,
          });
          currentCompanion = "Boolean";
          currentType = checker.getBooleanType();
          continue;
        }
        if (currentCompanion === "DateTime" || isDateTimeType(currentType)) {
          stageResolutions.set(stage.span.start.offset, {
            module: "DateTime",
            method,
            isComparison: true,
          });
          currentCompanion = "Boolean";
          currentType = checker.getBooleanType();
          continue;
        }
        if (
          currentType &&
          !(currentType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
        ) {
          const typeStr = checker.typeToString(currentType);
          if (tolerateUnresolvedStages) {
            currentCompanion = undefined;
            continue;
          }
          throw new PipelineResolutionError(
            `< or comparison '${fnName}' is only available for supported ordered types (Number, DateTime); this operand has type ${typeStr}. Use Order.isLessThan(...) or an explicit domain Order. See docs/syntax.md#42-equality-and-comparisons.`,
            stage.span,
          );
        }
      }

      // 2. String companion operations
      if (
        currentCompanion === "String" &&
        STRING_COMPANION_METHODS.has(fnName) &&
        !ES_TOOLKIT_STRING_METHODS.has(fnName)
      ) {
        const method = fnName === "lines" ? "linesIterator" : fnName;
        stageResolutions.set(stage.span.start.offset, {
          module: "String",
          method,
        });
        if (fnName === "lines" || fnName === "split") {
          currentCompanion = "Array";
        } else {
          currentCompanion = "String";
        }
        continue;
      }

      // 3. Duration operations
      if (
        currentCompanion === "Number" &&
        DURATION_COMPANION_METHODS.has(fnName)
      ) {
        stageResolutions.set(stage.span.start.offset, {
          module: "Duration",
          method: fnName,
        });
        currentCompanion = "Duration";
        continue;
      }

      // 4. Catalog module operations (Array, Option, Effect, etc.)
      if (currentCompanion && currentCompanion in PIPELINE_COMPANION_CATALOG) {
        const catalog =
          PIPELINE_COMPANION_CATALOG[
            currentCompanion as PipelineCompanionModule
          ];
        if (
          !ES_TOOLKIT_STRING_METHODS.has(fnName) &&
          catalog.includes(fnName)
        ) {
          const method = fnName;
          stageResolutions.set(stage.span.start.offset, {
            module: currentCompanion,
            method,
          });
          if (currentCompanion === "Array") {
            if (
              fnName === "head" ||
              fnName === "last" ||
              fnName === "findFirst" ||
              fnName === "findLast" ||
              fnName === "findFirstIndex" ||
              fnName === "findLastIndex" ||
              fnName === "get" ||
              fnName === "min" ||
              fnName === "max"
            ) {
              currentCompanion = "Option";
              currentType = checker.getAnyType();
            } else if (fnName === "length" || fnName === "countBy") {
              currentCompanion = "Number";
              currentType = checker.getNumberType();
            } else if (fnName === "join") {
              currentCompanion = "String";
              currentType = checker.getStringType();
            } else if (
              fnName === "some" ||
              fnName === "every" ||
              fnName === "contains" ||
              fnName === "containsWith" ||
              fnName === "isEmptyArray" ||
              fnName === "isNonEmptyArray"
            ) {
              currentCompanion = "Boolean";
              currentType = checker.getBooleanType();
            } else if (
              fnName === "headNonEmpty" ||
              fnName === "lastNonEmpty" ||
              fnName === "getUnsafe" ||
              fnName === "reduce" ||
              fnName === "reduceRight" ||
              fnName === "match" ||
              fnName === "matchLeft" ||
              fnName === "matchRight"
            ) {
              currentCompanion = undefined;
              currentType = checker.getAnyType();
            }
          } else if (currentCompanion === "Option") {
            if (fnName === "toArray") {
              currentCompanion = "Array";
              currentType = checker.getAnyType();
            } else if (fnName === "orElseResult") {
              currentCompanion = "Result";
              currentType = checker.getAnyType();
            } else if (
              fnName === "isSome" ||
              fnName === "isNone" ||
              fnName === "contains" ||
              fnName === "exists"
            ) {
              currentCompanion = "Boolean";
              currentType = checker.getBooleanType();
            } else if (
              fnName === "getOrElse" ||
              fnName === "getOrNull" ||
              fnName === "getOrUndefined" ||
              fnName === "getOrThrow" ||
              fnName === "getOrThrowWith" ||
              fnName === "match" ||
              fnName === "reduceCompact"
            ) {
              currentCompanion = undefined;
              currentType = checker.getAnyType();
            }
          } else if (currentCompanion === "Result") {
            if (fnName === "getSuccess" || fnName === "getFailure") {
              currentCompanion = "Option";
              currentType = checker.getAnyType();
            } else if (
              fnName === "getOrElse" ||
              fnName === "getOrNull" ||
              fnName === "getOrUndefined" ||
              fnName === "getOrThrow" ||
              fnName === "getOrThrowWith" ||
              fnName === "merge" ||
              fnName === "match"
            ) {
              currentCompanion = undefined;
              currentType = checker.getAnyType();
            }
          } else if (currentCompanion === "Chunk") {
            if (
              fnName === "head" ||
              fnName === "last" ||
              fnName === "get" ||
              fnName === "findFirst" ||
              fnName === "findLast" ||
              fnName === "findFirstIndex" ||
              fnName === "findLastIndex"
            ) {
              currentCompanion = "Option";
              currentType = checker.getAnyType();
            } else if (fnName === "toArray" || fnName === "toReadonlyArray") {
              currentCompanion = "Array";
              currentType = checker.getAnyType();
            } else if (fnName === "size") {
              currentCompanion = "Number";
              currentType = checker.getNumberType();
            } else if (fnName === "containsWith") {
              currentCompanion = "Boolean";
              currentType = checker.getBooleanType();
            } else if (
              fnName === "headNonEmpty" ||
              fnName === "lastNonEmpty" ||
              fnName === "headUnsafe" ||
              fnName === "lastUnsafe" ||
              fnName === "getUnsafe"
            ) {
              currentCompanion = undefined;
              currentType = checker.getAnyType();
            }
          }
          continue;
        }
      }

      // 4b. es-toolkit operations (pure string, math data-last, timing)
      if (
        ES_TOOLKIT_METHODS.has(fnName) &&
        !isShadowed(stage.span.start.offset, fnName)
      ) {
        if (ES_TOOLKIT_STRING_METHODS.has(fnName)) {
          currentCompanion = "String";
          currentType = checker.getStringType();
        } else if (ES_TOOLKIT_MATH_DATA_LAST.has(fnName)) {
          if (fnName === "inRange") {
            currentCompanion = "Boolean";
            currentType = checker.getBooleanType();
          } else {
            currentCompanion = "Number";
            currentType = checker.getNumberType();
          }
        } else if (ES_TOOLKIT_MATH_COLLECTION.has(fnName)) {
          currentCompanion = "Number";
          currentType = checker.getNumberType();
        } else if (ES_TOOLKIT_TIMING_DATA_LAST.has(fnName)) {
          currentCompanion = undefined;
        }
        continue;
      }

      // 5. Custom Abstractions (e.g. HttpClient, HttpResponse)
      if (currentCompanion) {
        const sym =
          checker.resolveName(
            currentCompanion,
            sourceFile,
            ts.SymbolFlags.Value | ts.SymbolFlags.Namespace,
            false,
          ) ??
          checker.resolveName(
            currentCompanion,
            sourceFile,
            ts.SymbolFlags.Type,
            false,
          );
        if (sym) {
          const symType = checker.getTypeOfSymbolAtLocation(sym, sourceFile);
          const prop =
            checker.getPropertyOfType(symType, fnName) ??
            sym.exports?.get(ts.escapeLeadingUnderscores(fnName));
          if (prop) {
            stageResolutions.set(stage.span.start.offset, {
              module: currentCompanion,
              method: fnName,
            });
            const propType = checker.getTypeOfSymbolAtLocation(
              prop,
              sourceFile,
            );
            let ret = propType.getCallSignatures()[0]?.getReturnType();
            if (ret && ret.getCallSignatures().length > 0) {
              ret = ret.getCallSignatures()[0].getReturnType();
            }
            if (ret) {
              currentType = ret;
              currentCompanion = companionForType(ret);
            }
            continue;
          }
        }
        if (!isShadowed(stage.span.start.offset, fnName)) {
          if (tolerateUnresolvedStages) {
            currentCompanion = undefined;
            continue;
          }
          throw new PipelineResolutionError(
            `${fnName} cannot be resolved for ${currentCompanion}. Explicit Module.${fnName} qualification is available.`,
            stage.span,
          );
        }
      }

      // 6. Undefined companion: check candidate ambiguity
      if (!currentCompanion) {
        if (
          fnName === "retry" &&
          stage.kind === "CallExpression" &&
          stage.args.length === 1 &&
          stage.args[0].kind === "RecordExpression"
        ) {
          stageResolutions.set(stage.span.start.offset, {
            module: "Effect",
            method: "retry",
          });
          currentCompanion = "Effect";
          continue;
        }
        const candidates = pipelineCompanionCandidates(fnName);
        if (candidates.length > 1) {
          if (tolerateUnresolvedStages) continue;
          const optionHint = candidates.includes("Option")
            ? " (or lift nullable JS values with fromNullishOr(...) first)"
            : "";
          throw new PipelineResolutionError(
            `${fnName} is ambiguous for this pipeline; write ${candidates.map((m) => `${m}.${fnName}(...)`).join(" or ")}${optionHint}`,
            stage.span,
          );
        } else if (candidates.length === 1) {
          stageResolutions.set(stage.span.start.offset, {
            module: candidates[0],
            method: fnName,
          });
          currentCompanion = candidates[0];
          continue;
        }
      }
    }

    const bindingInfo = pipelineBindingNames.get(pipeline.span.start.offset);
    if (
      bindingInfo &&
      currentCompanion &&
      currentCompanion in PIPELINE_COMPANION_CATALOG
    ) {
      let targetScopeId = bindingInfo.scopeId;
      if (bindingInfo.isAssignment) {
        let sid: number | undefined = bindingInfo.scopeId;
        while (sid !== undefined) {
          if (scopeDeclaredNames.get(sid)?.has(bindingInfo.name)) {
            targetScopeId = sid;
            break;
          }
          sid = scopeParent.get(sid);
        }
      }
      let scopeMap = bindingCompanions.get(targetScopeId);
      if (!scopeMap) {
        scopeMap = new Map();
        bindingCompanions.set(targetScopeId, scopeMap);
      }
      scopeMap.set(
        bindingInfo.name,
        currentCompanion as PipelineCompanionModule,
      );
    }
  }

  // 2. Process direct calls
  const directCalls = collectDirectCalls(ast);
  for (const call of directCalls) {
    if (call.callee.kind !== "Identifier") continue;
    const name = call.callee.name;
    const directNode = directCallNodes.get(call.span.start.offset);
    if (!directNode) continue;
    const argType = checker.getTypeAtLocation(directNode.arguments[1]);

    if (name in COMPARISON_METHOD_MAP) {
      const method = COMPARISON_METHOD_MAP[name];
      if (argType.flags & ts.TypeFlags.NumberLike) {
        directCallResolutions.set(call.span.start.offset, {
          module: "Number",
          method,
          isComparison: true,
        });
        continue;
      }
      if (isDateTimeType(argType)) {
        directCallResolutions.set(call.span.start.offset, {
          module: "DateTime",
          method,
          isComparison: true,
        });
        continue;
      }
      const typeStr = checker.typeToString(argType);
      throw new FunScriptError(
        `comparison '${name}' is only available for supported ordered types (Number, DateTime); this operand has type ${typeStr}. Use Order.isLessThan(...) or an explicit domain Order. See docs/syntax.md#42-equality-and-comparisons.`,
        call.span,
      );
    }

    if (!isShadowed(call.span.start.offset, name)) {
      const comp = companionForType(argType);
      if (comp) {
        const sym = checker.resolveName(
          comp,
          sourceFile,
          ts.SymbolFlags.Value | ts.SymbolFlags.Namespace,
          false,
        );
        if (sym) {
          const symType = checker.getTypeOfSymbolAtLocation(sym, sourceFile);
          const prop =
            checker.getPropertyOfType(symType, name) ??
            sym.exports?.get(ts.escapeLeadingUnderscores(name));
          if (prop) {
            directCallResolutions.set(call.span.start.offset, {
              module: comp,
              method: name,
            });
          }
        }
      }
    }
  }

  const result = companions as Map<number, PipelineCompanionModule> & {
    pipelineCompanions: ReadonlyMap<number, PipelineCompanionModule>;
    stageResolutions: ReadonlyMap<number, StageResolution>;
    stageInputCompanions: ReadonlyMap<number, string>;
    bareStageResolutions: ReadonlyMap<number, StageResolution>;
    directCallResolutions: ReadonlyMap<number, StageResolution>;
  };
  result.pipelineCompanions = companions;
  result.stageResolutions = stageResolutions;
  result.stageInputCompanions = stageInputCompanions;
  result.bareStageResolutions = bareStageResolutions;
  result.directCallResolutions = directCallResolutions;
  return result;
}
