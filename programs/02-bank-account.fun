# Program 02: Bank Account with Tagged Unions, Pattern Matching & Immutability

import { Console } from "effect"

export schema Account = {
  id: String
  owner: String
  balance: Number
}

export schema Action =
  | Deposit(amount: Number)
  | Withdraw(amount: Number)
  | Freeze

export applyAction = (acc: Account, action: Action): Account ->
  match action
    | Deposit(amount) -> { ...acc, balance: acc.balance + amount }
    | Withdraw(amount) when acc.balance |> greaterThanOrEqualTo(amount) ->
        { ...acc, balance: acc.balance - amount }
    | Withdraw(amount) -> acc
    | Freeze -> acc

export formatAccount = (acc: Account) ->
  "Account {acc.id} ({acc.owner}): Balance = ${acc.balance}"

export initialAccount: Account = {
  id: "ACC-101"
  owner: "Ada Lovelace"
  balance: 100
}

export main =
  [Deposit(50), Withdraw(30), Deposit(200), Withdraw(500), Withdraw(20)]
  |> reduce(initialAccount, applyAction)
  |> formatAccount
  |> Console.log
