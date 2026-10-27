import { Array, Data, Effect, Schema, pipe } from "effect";
import { match, P } from "ts-pattern";

import { Effect, Console, Array } from "effect";

export const Todo = Schema.Struct({
  id: Schema.Number,
  title: Schema.String,
  completed: Schema.Boolean,
  priority: Schema.String
});
export type Todo = typeof Todo.Type;

export type Action = Data.TaggedEnum<{
  AddTodo: { readonly title: string; readonly priority: string };
  ToggleTodo: { readonly id: number };
  RemoveTodo: { readonly id: number };
  ClearCompleted: {}
}>;
const $Action = Data.taggedEnum<Action>();
export const AddTodo = (title: string, priority: string): Action => $Action.AddTodo({ title, priority });
export const ToggleTodo = (id: number): Action => $Action.ToggleTodo({ id });
export const RemoveTodo = (id: number): Action => $Action.RemoveTodo({ id });
export const ClearCompleted: Action = $Action.ClearCompleted();

export const reduceTodos = (todos: Array<Todo>, action: Action) => {

  return match(action)
  .with({ _tag: "AddTodo" }, ($matched) => {
    const { _tag: _, ...__fields } = $matched as any;
    const [title, priority] = Object.values(__fields) as any[];
  const newId = (todos.length + 1);
  const newTodo: Todo = { id: newId, title: title, completed: false, priority: priority };
  return pipe(
  todos,
  Array.append(newTodo)
);
  })
  .with({ _tag: "ToggleTodo" }, ($matched) => {
    const { _tag: _, ...__fields } = $matched as any;
    const [id] = Object.values(__fields) as any[];

  return pipe(
  todos,
  Array.map((t: Todo) => {

  return ((t.id === id) ? { ...t, completed: (!t.completed) } : t);
})
);
  })
  .with({ _tag: "RemoveTodo" }, ($matched) => {
    const { _tag: _, ...__fields } = $matched as any;
    const [id] = Object.values(__fields) as any[];

  return pipe(
  todos,
  Array.filter((t: Todo) => (t.id !== id))
);
  })
  .with({ _tag: "ClearCompleted" }, () => {

  return pipe(
  todos,
  Array.filter((t: Todo) => (!t.completed))
);
})
  .exhaustive();
};

export const getVisibleTodos = (todos: Array<Todo>, filterName: string) => {

  return match(filterName)
  .with("active", () => pipe(
  todos,
  Array.filter((t: Todo) => (!t.completed))
))
  .with("completed", () => pipe(
  todos,
  Array.filter((t: Todo) => t.completed)
))
  .otherwise(() => todos);
};

export const fetchInitialTodos = Effect.gen(function* () {
    yield* Console.log("[FunScript API] Fetching initial todos...");
    const todos: Array<Todo> = [{ id: 1, title: "Learn SolidJS fine-grained reactivity", completed: true, priority: "high" }, { id: 2, title: "Design FunScript state machine", completed: true, priority: "high" }, { id: 3, title: "Dogfood SolidJS + FunScript integration", completed: false, priority: "medium" }];
    return todos;
  });

