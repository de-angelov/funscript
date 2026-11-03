const OPERATOR_CATALOG: Record<string, { precedence: number; associativity: "left" | "right" }> = {
  "or": { precedence: 1, associativity: "left" },
  "and": { precedence: 2, associativity: "left" },
  "#=": { precedence: 4, associativity: "left" },
  "#!": { precedence: 4, associativity: "left" },
  "@=": { precedence: 4, associativity: "left" },
  "@!": { precedence: 4, associativity: "left" },
  "<": { precedence: 5, associativity: "left" },
  "<=": { precedence: 5, associativity: "left" },
  ">": { precedence: 5, associativity: "left" },
  ">=": { precedence: 5, associativity: "left" },
  "+": { precedence: 6, associativity: "left" },
  "-": { precedence: 6, associativity: "left" },
  "*": { precedence: 7, associativity: "left" },
  "/": { precedence: 7, associativity: "left" },
  "%": { precedence: 7, associativity: "left" },
  "**": { precedence: 8, associativity: "right" },
};

export const PRECEDENCE: Record<string, number> = Object.fromEntries(
  Object.entries(OPERATOR_CATALOG).map(([operator, metadata]) => [operator, metadata.precedence]),
);

export const ASSOCIATIVITY: Record<string, "left" | "right"> = Object.fromEntries(
  Object.entries(OPERATOR_CATALOG).map(([operator, metadata]) => [operator, metadata.associativity]),
);
