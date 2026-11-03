import { Schema } from "effect";

export const User = Schema.Struct({
  id: Schema.String,
  name: Schema.String
});
export type User = typeof User.Type;
export const UserFromUnknown = (input: unknown): User => Schema.decodeUnknownSync(User)(input);
