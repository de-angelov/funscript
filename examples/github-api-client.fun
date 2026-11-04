// Program 05: GitHub REST API Client & Response Handler
// Demonstrates:
// 1. Foreign Promise / fetch interop via 'js' in Effect blocks
// 2. Schema decoding and validation with Schema.Struct & Schema.decodeUnknownSync
// 3. Pipelines with '|>' for data transformation
// 4. Error handling with Effect TaggedError
// 5. Pattern matching on response states (Success, RateLimited, NotFound, ServerError)

import { Console, Effect, Schema } from "effect"

// --- Domain Data Model & Schemas ---

export schema Repository = {
  id: Number
  name: String
  fullName: String
  description: String
  stargazersCount: Number
  forksCount: Number
  openIssuesCount: Number
}

export schema ApiResponse =
  | Success(repo: Repository)
  | RateLimited(resetTime: Number, remaining: Number)
  | NotFound(repoName: String)
  | ServerError(statusCode: Number, message: String)

// Effect TaggedError representation
export error GithubApiError(statusCode: Number, message: String)

export schema RateLimitInfo = {
  resetTime: Number
  remaining: Number
}

export schema RawApiResponse = {
  status: Number
  message: String
  json: Unknown
}

// Simulated REST API fetch client with deterministic test fixtures
export executeFetch = (repoPath: String) =>
  match repoPath
    | "effect-ts/effect" =>
        Promise.resolve({
          status: 200
          message: ""
          json: {
            id: 101
            name: "effect"
            fullName: "Effect-TS/effect"
            description: "A fully-fledged functional effect system for TypeScript"
            stargazersCount: 9500
            forksCount: 680
            openIssuesCount: 42
          }
        })
    | "funscript/funscript" =>
        Promise.resolve({
          status: 200
          message: ""
          json: {
            id: 202
            name: "funscript"
            fullName: "funscript/funscript"
            description: "Lightweight functional notation compiling directly to TypeScript"
            stargazersCount: 1337
            forksCount: 88
            openIssuesCount: 3
          }
        })
    | "rate/limit" =>
        Promise.resolve({
          status: 403
          message: "Rate limit exceeded"
          json: { resetTime: 1730000000, remaining: 0 }
        })
    | "ghost/nonexistent" =>
        Promise.resolve({
          status: 404
          message: "Repository not found"
          json: {}
        })
    | _ =>
        Promise.resolve({
          status: 500
          message: "Internal GitHub API server error"
          json: {}
        })

// --- Response Parsing & Pipelines ---

export parseResponse = (repoPath: String, raw: RawApiResponse): ApiResponse =>
  match raw.status
    | 200 => Success(raw.json |> Schema.decodeUnknownSync(Repository))
    | 403 =>
        info = raw.json |> Schema.decodeUnknownSync(RateLimitInfo)
        RateLimited(info.resetTime, info.remaining)
    | 404 => NotFound(repoPath)
    | _ => ServerError(raw.status, raw.message)

// Pattern matching on ApiResponse variants
export formatApiResponse = (res: ApiResponse) =>
  match res
    | Success(repo) =>
        "[200 OK] " + repo.fullName + " - " + repo.description + " (Stars: " + repo.stargazersCount + ", Forks: " + repo.forksCount + ")"
    | RateLimited(resetTime, remaining) =>
        "[403 Rate Limited] Remaining: " + remaining + ", Reset timestamp: " + resetTime
    | NotFound(repoName) =>
        "[404 Not Found] Repository '" + repoName + "' does not exist"
    | ServerError(statusCode, message) =>
        // Client function using 'js' interop in Effect block
        "[Error " + statusCode + "] " + message

export fetchRepo = (repoPath: String) =>
  effect {
    _ <- Console.log("[GitHub Client] Requesting repository: " + repoPath)
    raw <- js executeFetch(repoPath)
    parsed = parseResponse(repoPath, raw)
    => parsed
  }

// Summary formatter for a batch of repositories
export summarizeRepo = (repo: Repository) =>
  => repo.fullName + " (⭐ " + repo.stargazersCount + " | 🍴 " + repo.forksCount + " | ⚠️ " + repo.openIssuesCount + ")"

// --- Main Program Runner ---

export main =
  effect {
    _ <- Console.log("=== GitHub API Client Dogfooding ===")

    // 1. Fetch valid repository
    r1 <- fetchRepo("effect-ts/effect")
    _ <- Console.log(formatApiResponse(r1))

    // 2. Fetch second valid repository
    r2 <- fetchRepo("funscript/funscript")
    _ <- Console.log(formatApiResponse(r2))

    // 3. Handle 403 Rate Limited response
    r3 <- fetchRepo("rate/limit")
    _ <- Console.log(formatApiResponse(r3))

    // 4. Handle 404 Not Found response
    r4 <- fetchRepo("ghost/nonexistent")
    _ <- Console.log(formatApiResponse(r4))

    _ <- Console.log("=== GitHub API Client Completed Successfully ===")
    => 0
  }
