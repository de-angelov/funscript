/** External TypeScript type definitions for imported schema validation example. */

export type UserRole = "admin" | "member" | "guest";

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  age?: number;
  bio: string | null;
  tags: string[];
}
