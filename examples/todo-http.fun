# FunScript — effect blocks, `schema` declarations, record spread updates, retry, and layers.

import { Console, Effect, Schedule } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http"

export schema Todo = {
  id: Int
  title: NonEmptyString
  completed: Boolean
}

export completeTodo = (todo: Todo) ->
  { ...todo, completed: true }

export fetchTodo = (id: Number) ->
  effect
    response <- HttpClient.get("https://jsonplaceholder.typicode.com/todos/{id}")
    todo <- response |> HttpClientResponse.schemaBodyJson(Todo)
    completeTodo(todo)
  |> Effect.retry(Schedule.exponential("100 millis"))
  |> Effect.provide(FetchHttpClient.layer)

export main =
  effect
    todo <- fetchTodo(1)
    _ <- Console.log("Fetched: {todo.title} (completed: {todo.completed})")
    todo
