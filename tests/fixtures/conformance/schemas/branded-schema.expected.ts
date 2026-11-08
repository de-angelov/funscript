import { Brand, Schema } from "effect";

export const UserId = Schema.String.pipe(Schema.brand("UserId"));
export type UserId = string & Brand.Brand<"UserId">;
export const UserIdFromUnknown = (input: unknown): UserId => Schema.decodeUnknownSync(UserId)(input);
