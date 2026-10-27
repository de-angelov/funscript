# Program 02: Bank Account with Tagged Unions, Pattern Matching & Immutability

import { Console, Array, pipe, Number } from "effect"

export schema Account = {
  id: string
  owner: string
  balance: number
}

export schema Action =
  | Deposit(amount: number)
  | Withdraw(amount: number)
  | Freeze

export applyAction = (acc: Account, action: Action): Account ->
  match action
    | Deposit(amount) -> { ...acc, balance: acc.balance + amount }
    | Withdraw(amount) when acc.balance |> Number.greaterThanOrEqualTo(amount) ->
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
  |> Array.reduce(initialAccount, applyAction)
  |> formatAccount
  |> Console.log
