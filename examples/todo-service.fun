// Program 03: Todo Service with Direct Service Calls and Layers

import { Console, Effect, Layer, Array, pipe } from "effect"

export schema Todo = {
  id: Number
  title: String
  completed: Boolean
}

export error TodoNotFound(id: Number)

export service TodoRepo
  create: (title: String) => Effect<Todo>
  complete: (id: Number) => Effect<Todo, TodoNotFound>
  all: () => Effect<Array<Todo>>

// In-memory layer implementation using local store:
mut store: Array<Todo> = []

export TodoRepoLive =
  Layer.succeed(TodoRepo, {
    create: (title) =>
      effect {
        id = store.length + 1
        newTodo: Todo = { id, title, completed: false }
        store = store |> Array.append(newTodo)
        => newTodo
      }

    complete: (id) =>
      idx = store.findIndex((t) => t.id #= id)
      match
        | idx #= -1 => Effect.fail(TodoNotFound({ id }))
        | _ =>
            match store[idx]
              | Some(todo) =>
                  updated = { ...todo, completed: true }
                  store = store |> mut (draft) =>
                    draft[idx] = updated
                    draft
                  Effect.succeed(updated)
              | None => Effect.fail(TodoNotFound({ id }))

    all: () =>
      => Effect.succeed(store)
  })

export formatTodo = (t: Todo) =>
  status = match | t.completed => "[x]" | _ => "[ ]"
  => "{status} #{t.id}: {t.title}"

export program =
  effect {
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
      |> map(formatTodo)
      |> join("\n")
    _ <- Console.log(summary)
    => todos
  }

export main =
  program
  |> Effect.provide(TodoRepoLive)
