# Program 03: Todo Service with Direct Service Calls and Layers

import { Console, Effect, Layer, Array, pipe } from "effect"

export schema Todo = {
  id: number
  title: string
  completed: boolean
}

export error TodoNotFound(id: number)

export service TodoRepo
  create: (title: string) -> Effect<Todo>
  complete: (id: number) -> Effect<Todo, TodoNotFound>
  all: () -> Effect<Array<Todo>>

# In-memory layer implementation using local store:
mut store: Array<Todo> = []

export TodoRepoLive =
  Layer.succeed(TodoRepo, {
    create: (title) ->
      effect
        id = store.length + 1
        newTodo: Todo = { id, title, completed: false }
        _ = store.push(newTodo)
        newTodo

    complete: (id) ->
      idx = store.findIndex((t) -> t.id == id)
      match
        | idx == -1 -> Effect.fail(TodoNotFound(id))
        | _ ->
            updated = { ...store[idx], completed: true }
            _ = store.splice(idx, 1, updated)
            Effect.succeed(updated)

    all: ->
      Effect.succeed(store)
  })

export formatTodo = (t: Todo) ->
  status = match | t.completed -> "[x]" | _ -> "[ ]"
  "{status} #{t.id}: {t.title}"

export program =
  effect
    t1 <- TodoRepo.create("Buy coffee beans")
    t2 <- TodoRepo.create("Design FunScript parser")
    t3 <- TodoRepo.create("Write blog post")
    _ <- Console.log("Created 3 initial todos.")

    _ <- TodoRepo.complete(t1.id)
    _ <- TodoRepo.complete(t2.id)
    _ <- Console.log("Completed tasks #1 and #2.")

    todos <- TodoRepo.all()
    _ <- Console.log("--- Current Todo List ---")
    summary =
      todos
      |> Array.map(formatTodo)
      |> Array.join("\n")
    _ <- Console.log(summary)
    todos

export main =
  program
  |> Effect.provide(TodoRepoLive)
