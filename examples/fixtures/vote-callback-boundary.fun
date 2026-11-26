// Country Rank 2-inspired boundary experiment. No network or Redis is required.
import { Effect, Schema } from "effect"
import { checkedEffect } from "funscript/callback"

export schema VoteRequest = {
  countryCode: String
  voteType: "like" | "dislike"
}

export schema VoteResult = {
  countryCode: String
  likes: Number
  dislikes: Number
}

export schema VoteError = {
  code: String
  cause: Unknown
}

// Currently a type-only contract; it does not generate a decoder.
export schema VoteHandler = {
  submit: (request: VoteRequest) => Effect<VoteResult, VoteError>
}

// The foreign callback is typed for its input and failure, but its result is untrusted.
export createVoteHandler = (foreign: (request: VoteRequest) => Effect<Unknown, VoteError>): VoteHandler =>
  checked = checkedEffect(foreign, Schema.Tuple([VoteRequest]), VoteResult)
  submit = (request: VoteRequest) =>
    checked(request)
    |> Effect.mapError((failure) => { code: "vote_failed", cause: failure })
  => { submit: submit }

export castVote = (handler: VoteHandler, request: VoteRequest) =>
  handler.submit(request)

// Typed callback boundary: failure and service declarations come from the caller.
export checkTypedVoteHandler = (handler: VoteHandler) => VoteHandlerDecodeChecked(handler)
