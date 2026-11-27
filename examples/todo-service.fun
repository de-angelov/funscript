// Program 03: Todo Service with Direct Service Calls and Layers

import { Console, Effect, Layer, Array, Ref, pipe } from "effect"

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
export TodoRepoLive =
  Layer.effect(TodoRepo, effect {
    initialStore: Array<Todo> = []
    store <- Ref.make(initialStore)
    => {
      create: (title) =>
        effect {
          items <- Ref.get(store)
          id = items.length + 1
          newTodo: Todo = {
            id
            title
            completed: false
          }
          _ <- Ref.update(store, (curr) => curr |> append(newTodo))
          => newTodo
        }

      complete: (id) =>
        effect {
          items <- Ref.get(store)
          idxOpt = items |> findFirstIndex((t) => t.id #= id)
          res <- match idxOpt
            | Some(idx) =>
                items[idx]
                |> Option.match({
                  onNone: () => Effect.fail(TodoNotFound({ id }))
                  onSome: (todo) =>
                    effect {
                      updated = { ...todo, completed: true }
                      _ <- Ref.update(store, (curr) =>
                        curr
                        |> mut (draft) =>
                          draft[idx] = updated
                          draft
                      )
                      => updated
                    }
                })
            | None => Effect.fail(TodoNotFound({ id }))
          => res
        }

      all: () => Ref.get(store)
    }
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
  |> provide(TodoRepoLive)
