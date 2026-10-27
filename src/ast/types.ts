/**
 * FunScript Abstract Syntax Tree (AST) definitions.
 */

export interface Position {
  line: number;   // 1-indexed
  column: number; // 1-indexed
  offset: number; // 0-indexed byte offset
}

export interface Span {
  start: Position;
  end: Position;
}

export interface NodeBase {
  span: Span;
}

export interface Program extends NodeBase {
  kind: "Program";
  body: TopLevelDeclaration[];
}

export type TopLevelDeclaration =
  | ImportDeclaration
  | ExportDeclaration
  | SchemaDeclaration
  | ErrorDeclaration
  | ServiceDeclaration
  | BindingDeclaration;

export interface ImportDeclaration extends NodeBase {
  kind: "ImportDeclaration";
  isTypeOnly: boolean;
  specifiers: ImportSpecifier[];
  source: StringLiteral;
}

export interface ImportSpecifier extends NodeBase {
  kind: "ImportSpecifier";
  isTypeOnly: boolean;
  imported: Identifier | UpperIdentifier;
  local: Identifier | UpperIdentifier;
}

export interface ExportDeclaration extends NodeBase {
  kind: "ExportDeclaration";
  declaration: SchemaDeclaration | ErrorDeclaration | ServiceDeclaration | BindingDeclaration;
}

export interface BindingDeclaration extends NodeBase {
  kind: "BindingDeclaration";
  isMut: boolean;
  id: Identifier | UpperIdentifier;
  typeAnnotation?: TypeNode;
  init: Expression;
}

export interface SchemaDeclaration extends NodeBase {
  kind: "SchemaDeclaration";
  id: UpperIdentifier;
  typeParams?: TypeParameter[];
  body: SchemaBody;
}

export type SchemaBody =
  | RecordSchema
  | TaggedUnionSchema
  | RefinementSchema
  | TypeSignatureSchema;

export interface RecordSchema extends NodeBase {
  kind: "RecordSchema";
  fields: RecordFieldSchema[];
}

export interface RecordFieldSchema extends NodeBase {
  kind: "RecordFieldSchema";
  name: Identifier;
  typeAnnotation: TypeNode;
  defaultValue?: Expression;
}

export interface TaggedUnionSchema extends NodeBase {
  kind: "TaggedUnionSchema";
  variants: VariantDeclaration[];
}

export interface VariantDeclaration extends NodeBase {
  kind: "VariantDeclaration";
  name: UpperIdentifier;
  fields: VariantField[];
}

export interface VariantField extends NodeBase {
  kind: "VariantField";
  name: Identifier;
  typeAnnotation: TypeNode;
}

export interface RefinementSchema extends NodeBase {
  kind: "RefinementSchema";
  baseType: TypeNode;
  refinement: Expression;
}

export interface TypeSignatureSchema extends NodeBase {
  kind: "TypeSignatureSchema";
  signature: FunctionTypeNode | EffectTypeNode;
}

export interface ErrorDeclaration extends NodeBase {
  kind: "ErrorDeclaration";
  id: UpperIdentifier;
  fields: ErrorField[];
}

export interface ErrorField extends NodeBase {
  kind: "ErrorField";
  name: Identifier;
  typeAnnotation: TypeNode;
}

export interface ServiceDeclaration extends NodeBase {
  kind: "ServiceDeclaration";
  id: UpperIdentifier;
  customTag?: StringLiteral;
  members: ServiceMember[];
}

export interface ServiceMember extends NodeBase {
  kind: "ServiceMember";
  name: Identifier;
  signature: FunctionTypeNode;
}

export type Expression =
  | Literal
  | Identifier
  | UpperIdentifier
  | Placeholder
  | TypedHole
  | PipelineExpression
  | BinaryExpression
  | UnaryExpression
  | CallExpression
  | MemberExpression
  | IndexExpression
  | RecordExpression
  | ArrayExpression
  | FunctionExpression
  | MutBlockExpression
  | MatchExpression
  | EffectBlockExpression
  | JSXElement
  | JSXSelfClosingElement;

export interface PipelineExpression extends NodeBase {
  kind: "PipelineExpression";
  left: Expression;
  right: Expression;
}

export interface BinaryExpression extends NodeBase {
  kind: "BinaryExpression";
  operator: "or" | "and" | "??" | "==" | "!=" | "+" | "-" | "*" | "/" | "%" | "**";
  left: Expression;
  right: Expression;
}

export interface UnaryExpression extends NodeBase {
  kind: "UnaryExpression";
  operator: "not" | "-";
  argument: Expression;
}

export interface CallExpression extends NodeBase {
  kind: "CallExpression";
  callee: Expression;
  args: Expression[];
}

export interface MemberExpression extends NodeBase {
  kind: "MemberExpression";
  object: Expression;
  property: Identifier;
}

export interface IndexExpression extends NodeBase {
  kind: "IndexExpression";
  object: Expression;
  index: Expression;
}

export interface RecordExpression extends NodeBase {
  kind: "RecordExpression";
  entries: RecordEntry[];
}

export type RecordEntry =
  | SpreadEntry
  | FieldEntry
  | DotPathEntry
  | ShorthandEntry;

export interface SpreadEntry extends NodeBase {
  kind: "SpreadEntry";
  argument: Expression;
}

export interface FieldEntry extends NodeBase {
  kind: "FieldEntry";
  key: Identifier;
  value: Expression;
}

export interface DotPathEntry extends NodeBase {
  kind: "DotPathEntry";
  path: Identifier[];
  value: Expression;
}

export interface ShorthandEntry extends NodeBase {
  kind: "ShorthandEntry";
  key: Identifier;
}

export interface ArrayExpression extends NodeBase {
  kind: "ArrayExpression";
  elements: Expression[];
}

export interface FunctionExpression extends NodeBase {
  kind: "FunctionExpression";
  typeParams?: TypeParameter[];
  params: Parameter[];
  returnType?: TypeNode;
  body: FunctionBody;
}

export type FunctionBody =
  | Expression
  | BlockStatement;

export interface BlockStatement extends NodeBase {
  kind: "BlockStatement";
  statements: Statement[];
  finalExpression: Expression;
}

export type Statement =
  | BindingDeclaration
  | AssignmentStatement
  | ExpressionStatement;

export interface AssignmentStatement extends NodeBase {
  kind: "AssignmentStatement";
  target: Identifier | DotPathExpression;
  value: Expression;
}

export interface DotPathExpression extends NodeBase {
  kind: "DotPathExpression";
  path: Identifier[];
}

export interface ExpressionStatement extends NodeBase {
  kind: "ExpressionStatement";
  expression: Expression;
}

export interface MutBlockExpression extends NodeBase {
  kind: "MutBlockExpression";
  draftParam: Identifier;
  body: FunctionBody;
}

export interface TypedHole extends NodeBase {
  kind: "TypedHole";
  label?: string;
}

export interface MatchExpression extends NodeBase {
  kind: "MatchExpression";
  scrutinee?: Expression;
  arms: MatchArm[];
}

export interface MatchArm extends NodeBase {
  kind: "MatchArm";
  pattern: Pattern;
  guard?: Expression;
  body: FunctionBody;
}

export type Pattern =
  | WildcardPattern
  | LiteralPattern
  | VariablePattern
  | ConstructorPattern
  | RecordPattern
  | ArrayPattern
  | OrPattern;

export interface WildcardPattern extends NodeBase {
  kind: "WildcardPattern";
}

export interface LiteralPattern extends NodeBase {
  kind: "LiteralPattern";
  literal: Literal;
}

export interface VariablePattern extends NodeBase {
  kind: "VariablePattern";
  name: Identifier;
}

export interface ConstructorPattern extends NodeBase {
  kind: "ConstructorPattern";
  constructorName: UpperIdentifier;
  args: Pattern[];
}

export interface RecordPattern extends NodeBase {
  kind: "RecordPattern";
  fields: RecordPatternField[];
}

export interface RecordPatternField extends NodeBase {
  kind: "RecordPatternField";
  key: Identifier;
  pattern?: Pattern;
}

export interface ArrayPattern extends NodeBase {
  kind: "ArrayPattern";
  elements: Pattern[];
}

export interface OrPattern extends NodeBase {
  kind: "OrPattern";
  patterns: Pattern[];
}

export interface EffectBlockExpression extends NodeBase {
  kind: "EffectBlockExpression";
  body: EffectStatement[];
  finalExpression: Expression;
}

export type EffectStatement =
  | EffectBindStatement
  | EffectDiscardStatement
  | BindingDeclaration
  | AssignmentStatement
  | EffectControlFlowStatement;

export interface EffectBindStatement extends NodeBase {
  kind: "EffectBindStatement";
  id: Identifier;
  effect: Expression;
}

export interface EffectDiscardStatement extends NodeBase {
  kind: "EffectDiscardStatement";
  effect: Expression;
}

export interface EffectControlFlowStatement extends NodeBase {
  kind: "EffectControlFlowStatement";
  statement: MatchExpression;
}

export type Literal =
  | NumberLiteral
  | StringLiteral
  | BooleanLiteral;

export interface NumberLiteral extends NodeBase {
  kind: "NumberLiteral";
  value: number;
  raw: string;
}

export interface StringLiteral extends NodeBase {
  kind: "StringLiteral";
  parts: StringPart[];
  raw: string;
}

export type StringPart =
  | StringRawPart
  | StringInterpolationPart;

export interface StringRawPart {
  kind: "StringRawPart";
  value: string;
}

export interface StringInterpolationPart {
  kind: "StringInterpolationPart";
  expression: Expression;
}

export interface BooleanLiteral extends NodeBase {
  kind: "BooleanLiteral";
  value: boolean;
}

export interface Identifier extends NodeBase {
  kind: "Identifier";
  name: string;
}

export interface UpperIdentifier extends NodeBase {
  kind: "UpperIdentifier";
  name: string;
}

export interface Placeholder extends NodeBase {
  kind: "Placeholder";
}

export type TypeNode =
  | TypeReferenceNode
  | FunctionTypeNode
  | EffectTypeNode
  | RecordTypeNode
  | ArrayTypeNode
  | UnionTypeNode;

export interface TypeReferenceNode extends NodeBase {
  kind: "TypeReferenceNode";
  name: UpperIdentifier | Identifier;
  typeArgs?: TypeNode[];
}

export interface TypeParameter extends NodeBase {
  kind: "TypeParameter";
  name: UpperIdentifier;
}

export interface Parameter extends NodeBase {
  kind: "Parameter";
  name: Identifier;
  typeAnnotation?: TypeNode;
}

export interface FunctionTypeNode extends NodeBase {
  kind: "FunctionTypeNode";
  typeParams?: TypeParameter[];
  params: ParameterType[];
  returnType: TypeNode;
}

export interface ParameterType extends NodeBase {
  kind: "ParameterType";
  name?: Identifier;
  typeAnnotation: TypeNode;
}

export interface EffectTypeNode extends NodeBase {
  kind: "EffectTypeNode";
  success: TypeNode;
  error?: TypeNode;
  requirements?: TypeNode;
}

export interface RecordTypeNode extends NodeBase {
  kind: "RecordTypeNode";
  fields: RecordTypeField[];
}

export interface RecordTypeField extends NodeBase {
  kind: "RecordTypeField";
  name: Identifier;
  typeAnnotation: TypeNode;
}

export interface ArrayTypeNode extends NodeBase {
  kind: "ArrayTypeNode";
  elementType: TypeNode;
}

export interface UnionTypeNode extends NodeBase {
  kind: "UnionTypeNode";
  types: TypeNode[];
}

// --- JSX Nodes ---

export type JSXTagName = Identifier | UpperIdentifier | MemberExpression;

export type JSXAttributeValue = StringLiteral | JSXExpressionContainer | Expression;

export interface JSXAttribute extends NodeBase {
  kind: "JSXAttribute";
  name: Identifier | UpperIdentifier;
  value?: JSXAttributeValue;
}

export interface JSXExpressionContainer extends NodeBase {
  kind: "JSXExpressionContainer";
  expression: Expression;
}

export interface JSXText extends NodeBase {
  kind: "JSXText";
  value: string;
  raw?: string;
}

export type JSXChild =
  | JSXElement
  | JSXSelfClosingElement
  | JSXText
  | JSXExpressionContainer;

export interface JSXOpeningElement extends NodeBase {
  kind: "JSXOpeningElement";
  name: JSXTagName;
  attributes: JSXAttribute[];
}

export interface JSXClosingElement extends NodeBase {
  kind: "JSXClosingElement";
  name: JSXTagName;
}

export interface JSXSelfClosingElement extends NodeBase {
  kind: "JSXSelfClosingElement";
  name: JSXTagName;
  attributes: JSXAttribute[];
}

export interface JSXElement extends NodeBase {
  kind: "JSXElement";
  openingElement: JSXOpeningElement;
  children: JSXChild[];
  closingElement: JSXClosingElement;
}

