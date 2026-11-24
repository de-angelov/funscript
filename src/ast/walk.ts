/**
 * Generic AST traversal for FunScript syntax trees.
 * Traverses objects and arrays recursively, skipping the 'span' property.
 * A visitor can return `false` to skip visiting children of the current node.
 */
export type AstVisitor = (
  node: Record<string, unknown>,
  parent?: Record<string, unknown>,
  key?: string,
) => boolean | void;

export function walkAst(root: unknown, visitor: AstVisitor): void {
  const visit = (
    value: unknown,
    parent?: Record<string, unknown>,
    key?: string,
  ): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        visit(value[i], parent, key);
      }
      return;
    }
    const node = value as Record<string, unknown>;
    const res = visitor(node, parent, key);
    if (res === false) return;
    for (const [k, child] of Object.entries(node)) {
      if (k !== "span" && child && typeof child === "object") {
        visit(child, node, k);
      }
    }
  };
  visit(root);
}
