// Branded domain types and request schemas, written in FunScript.
// Note: Effect v4 composes checks with Schema.check(...) and brands with Schema.brand(...).

import { Schema } from "effect"

export schema Username = String |> Schema.check(Schema.isMinLength(3), Schema.isMaxLength(32)) |> Schema.brand("Username")
export schema LoginUsername = String |> Schema.check(Schema.isMinLength(1), Schema.isMaxLength(32)) |> Schema.brand("LoginUsername")
export schema Password = String |> Schema.check(Schema.isMinLength(8), Schema.isMaxLength(128)) |> Schema.brand("Password")
export schema LoginPassword = String |> Schema.check(Schema.isMinLength(1), Schema.isMaxLength(128)) |> Schema.brand("LoginPassword")
export schema HashedPassword = String |> Schema.brand("HashedPassword")
export schema UserId = Int |> Schema.brand("UserId")
export schema SessionToken = String |> Schema.check(Schema.isMinLength(1)) |> Schema.brand("SessionToken")

export schema RegisterCredentials = {
  username: Username
  password: Password
}

export schema LoginCredentials = {
  username: LoginUsername
  password: LoginPassword
}

export schema CurrentUser = {
  id: UserId
  username: Username
}

export schema Session = {
  user: CurrentUser
  token: SessionToken
}

export schema FormFields = {
  username: String
  password: String
}
