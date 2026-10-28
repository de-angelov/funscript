# Program 05: GitHub REST API Client & Response Handler
# Demonstrates:
# 1. Foreign Promise / fetch interop via 'js' in Effect blocks
# 2. Schema decoding and validation with Schema.Struct & Schema.decodeUnknownSync
# 3. Pipelines with '|>' for data transformation
# 4. Error handling with Effect TaggedError
# 5. Pattern matching on response states (Success, RateLimited, NotFound, ServerError)

import { Console } from "effect"

# --- Domain Data Model & Schemas ---

export schema Repository = {
  id: number
  name: string
  fullName: string
  description: string
  stargazersCount: number
  forksCount: number
  openIssuesCount: number
}

export schema ApiResponse =
  | Success(repo: Repository)
  | RateLimited(resetTime: number, remaining: number)
  | NotFound(repoName: string)
  | ServerError(statusCode: number, message: string)

# Effect TaggedError representation
export error GithubApiError(statusCode: number, message: string)

# TypeScript escape hatch for foreign fetch execution & error instantiation
ts
  export const makeGithubApiError = (statusCode: number, message: string) =>
    new GithubApiError({ statusCode, message });

  export interface RawApiResponse {
    status: number;
    headers?: Record<string, string>;
    json?: any;
    message?: string;
  }

  // Simulated REST API fetch client with deterministic test fixtures
  export async function executeFetch(repoPath: string): Promise<RawApiResponse> {
    if (repoPath === "effect-ts/effect") {
      return {
        status: 200,
        json: {
          id: 101,
          name: "effect",
          fullName: "Effect-TS/effect",
          description: "A fully-fledged functional effect system for TypeScript",
          stargazersCount: 9500,
          forksCount: 680,
          openIssuesCount: 42
        }
      };
    }
    if (repoPath === "funscript/funscript") {
      return {
        status: 200,
        json: {
          id: 202,
          name: "funscript",
          fullName: "funscript/funscript",
          description: "Lightweight functional notation compiling directly to TypeScript",
          stargazersCount: 1337,
          forksCount: 88,
          openIssuesCount: 3
        }
      };
    }
    if (repoPath === "rate/limit") {
      return {
        status: 403,
        json: { resetTime: 1730000000, remaining: 0 }
      };
    }
    if (repoPath === "ghost/nonexistent") {
      return {
        status: 404,
        message: "Repository not found"
      };
    }
    return {
      status: 500,
      message: "Internal GitHub API server error"
    };
  }

# --- Response Parsing & Pipelines ---

export parseResponse = (repoPath: string, raw: ts "RawApiResponse"): ApiResponse =>
  match raw.status
    | 200 => Success(raw.json |> Schema.decodeUnknownSync(Repository))
    | 403 => RateLimited(raw.json.resetTime, raw.json.remaining)
    | 404 => NotFound(repoPath)
    | _ => ServerError(raw.status, raw.message ?? "Unknown error")

# Pattern matching on ApiResponse variants
export formatApiResponse = (res: ApiResponse) =>
  match res
    | Success(repo) =>
        "[200 OK] " + repo.fullName + " - " + repo.description + " (Stars: " + repo.stargazersCount + ", Forks: " + repo.forksCount + ")"
    | RateLimited(resetTime, remaining) =>
        "[403 Rate Limited] Remaining: " + remaining + ", Reset timestamp: " + resetTime
    | NotFound(repoName) =>
        "[404 Not Found] Repository '" + repoName + "' does not exist"
    | ServerError(statusCode, message) =>
        "[Error " + statusCode + "] " + message

# Client function using 'js' interop in Effect block
export fetchRepo = (repoPath: string) =>
  effect
    _ <- Console.log("[GitHub Client] Requesting repository: " + repoPath)
    raw <- js executeFetch(repoPath)
    parsed = parseResponse(repoPath, raw)
    parsed

# Summary formatter for a batch of repositories
export summarizeRepo = (repo: Repository) =>
  repo.fullName + " (⭐ " + repo.stargazersCount + " | 🍴 " + repo.forksCount + " | ⚠️ " + repo.openIssuesCount + ")"

# --- Main Program Runner ---

export main =
  effect
    _ <- Console.log("=== GitHub API Client Dogfooding ===")

    # 1. Fetch valid repository
    r1 <- fetchRepo("effect-ts/effect")
    _ <- Console.log(formatApiResponse(r1))

    # 2. Fetch second valid repository
    r2 <- fetchRepo("funscript/funscript")
    _ <- Console.log(formatApiResponse(r2))

    # 3. Handle 403 Rate Limited response
    r3 <- fetchRepo("rate/limit")
    _ <- Console.log(formatApiResponse(r3))

    # 4. Handle 404 Not Found response
    r4 <- fetchRepo("ghost/nonexistent")
    _ <- Console.log(formatApiResponse(r4))

    _ <- Console.log("=== GitHub API Client Completed Successfully ===")
    0
