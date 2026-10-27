# Domain models and business logic for SolidJS integration demo
import { Effect, Console, Array } from "effect"

export schema Todo = {
  id: number
  title: string
  completed: boolean
  priority: string
}

export schema Action =
  | AddTodo(title: string, priority: string)
  | ToggleTodo(id: number)
  | RemoveTodo(id: number)
  | ClearCompleted

export reduceTodos = (todos: Array<Todo>, action: Action): Array<Todo> ->
  match action
    | AddTodo(title, priority) ->
        newId = todos.length + 1
        newTodo: Todo = {
          id: newId
          title: title
          completed: false
          priority: priority
        }
        todos |> append(newTodo)
    | ToggleTodo(id) ->
        todos |> map((t: Todo) ->
          match
            | t.id == id -> { ...t, completed: not t.completed }
            | _ -> t
        )
    | RemoveTodo(id) ->
        todos |> filter((t: Todo) -> t.id != id)
    | ClearCompleted ->
        todos |> filter((t: Todo) -> not t.completed)

export getVisibleTodos = (todos: Array<Todo>, filterName: string): Array<Todo> ->
  match filterName
    | "active" -> todos |> filter((t: Todo) -> not t.completed)
    | "completed" -> todos |> filter((t: Todo) -> t.completed)
    | _ -> todos

# Async Effect service simulating API loading
export fetchInitialTodos =
  effect
    _ <- Console.log("[FunScript API] Fetching initial todos...")
    todos: Array<Todo> = [
      {
        id: 1
        title: "Learn SolidJS fine-grained reactivity"
        completed: true
        priority: "high"
      },
      {
        id: 2
        title: "Design FunScript state machine"
        completed: true
        priority: "high"
      },
      {
        id: 3
        title: "Dogfood SolidJS + FunScript integration"
        completed: false
        priority: "medium"
      }
    ]
    todos
