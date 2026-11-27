// Branded domain types and request schemas, written in FunScript.
// Effect v4 composes checks with check(...) and brands with brand(...).

export schema Username = String |> check(isMinLength(3), isMaxLength(32)) |> brand("Username")

export schema LoginUsername = String |> check(isMinLength(1), isMaxLength(32)) |> brand("LoginUsername")

export schema Password = String |> check(isMinLength(8), isMaxLength(128)) |> brand("Password")

export schema LoginPassword = String |> check(isMinLength(1), isMaxLength(128)) |> brand("LoginPassword")

export schema HashedPassword = String |> brand("HashedPassword")

export schema UserId = Int |> brand("UserId")

export schema SessionToken = String |> check(isMinLength(1)) |> brand("SessionToken")

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
