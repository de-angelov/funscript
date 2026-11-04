export type StringAlias = string;
export type NumberAlias = number;
export type BooleanAlias = boolean;
export type TrueLiteral = true;
export type FalseLiteral = false;

export interface User {
  id: string;
  name: string;
  age?: number;
  bio: string | null;
  nickname?: string | null;
  tags: string[];
  matrix: number[][];
  role: "admin" | "member" | "guest";
  status: string | number;
}

export type StringArray = string[];
export type ReadonlyNumberArray = ReadonlyArray<number>;
export type FixedTuple = [string, number];
export type OptionalTuple = [string, number?];
export type Pair<T, U> = [T, U];
export type NamedValue<T> = { value: T };
export type InstantiatedPair = Pair<string, number>;
export type InstantiatedValue = NamedValue<number>;
export type StringNumberRecord = Record<string, number>;

export type StatusUnion = "active" | "inactive";
export type MixedUnion = string | number | null;

export interface NestedUser {
  id: string;
  profile: {
    avatar: string;
    description?: string;
  };
}

export interface OptionalUndefined {
  value?: string | undefined;
}

export interface TypeWithFunction {
  id: string;
  greet(): string;
}

export interface TypeWithAny {
  id: string;
  extra: any;
}

export interface TypeWithUnknown {
  id: string;
  data: unknown;
}

export interface TypeWithDate {
  id: string;
  createdAt: Date;
}

export class UserClass {
  constructor(public id: string) {}
}

export interface RecursiveTree {
  id: string;
  children: RecursiveTree[];
}

export type StringTagged =
  | { kind: "text"; value: string }
  | { kind: "count"; value: number };

export type BooleanTagged =
  | { enabled: true; label: string }
  | { enabled: false; reason: string };

export type NumericTagged =
  | { code: 1; message: string }
  | { code: 2; retryAfter: number };

export type StripeEvent =
  | {
      type: "checkout.session.completed";
      data: {
        object: {
          id: string;
          amount_total: number;
        };
      };
    }
  | {
      type: "payment_intent.payment_failed";
      data: {
        object: {
          id: string;
          last_payment_error: string;
        };
      };
    };
