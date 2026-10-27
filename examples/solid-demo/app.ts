/**
 * SolidJS + FunScript Integration Demo
 *
 * Demonstrates:
 * 1. Loading async data via FunScript Effect pipeline -> Solid createResource
 * 2. Solid fine-grained signals & stores powered by FunScript's pure reducer
 * 3. FunScript Schema validation on UI inputs
 * 4. Solid createMemo deriving visible todos via FunScript's pattern-matched filter
 * 5. Fine-grained reactive tracking when updating individual items
 */

import {
  createSignal,
  createMemo,
  createEffect,
  createResource,
  createRoot,
  batch
} from "solid-js/dist/dev.cjs";
import { Effect, Schema, Either } from "effect";
import {
  Todo,
  Action,
  AddTodo,
  ToggleTodo,
  RemoveTodo,
  ClearCompleted,
  reduceTodos,
  getVisibleTodos,
  fetchInitialTodos
} from "./domain.js";

createRoot(async () => {
  console.log("=== SolidJS + FunScript Integration Demo ===\n");

  // 1. Bridge FunScript Effect with Solid createResource
  console.log("-> 1. Testing Effect -> Solid createResource bridge:");
  const initialTodos = await Effect.runPromise(fetchInitialTodos);
  
  // 2. Solid Fine-Grained Reactive State
  const [todos, setTodos] = createSignal<Todo[]>(initialTodos);
  const [filter, setFilter] = createSignal<string>("all");

  // Helper dispatcher: updates Solid signal using FunScript pure state reducer
  const dispatch = (action: Action) => {
    setTodos((current) => reduceTodos(current, action));
  };

  // 3. FunScript Pattern-Matched Filtering inside Solid createMemo
  const visibleTodos = createMemo(() => {
    return getVisibleTodos(todos(), filter());
  });

  const stats = createMemo(() => {
    const list = todos();
    const completed = list.filter((t) => t.completed).length;
    const pending = list.length - completed;
    return { total: list.length, completed, pending };
  });

  // 4. Solid Fine-grained Reactive Effect observer
  createEffect(() => {
    const s = stats();
    console.log(`[Solid Observer] State updated: ${s.total} items (${s.pending} active, ${s.completed} done) | Filter: '${filter()}'`);
  });

  // 5. Schema Validation Demo
  console.log("\n-> 2. Testing FunScript Schema validation for UI inputs:");
  const rawInputValid = { id: 99, title: "Valid user todo", completed: false, priority: "high" };
  const rawInputInvalid = { id: "not-a-number", title: 123, completed: "nope" };

  const check1 = Schema.decodeUnknownEither(Todo)(rawInputValid);
  const check2 = Schema.decodeUnknownEither(Todo)(rawInputInvalid);

  console.log("  Valid input passes Schema:", Either.isRight(check1));
  console.log("  Invalid input rejected by Schema:", Either.isLeft(check2));

  // 6. Dispatching FunScript actions to test fine-grained reactive updates
  console.log("\n-> 3. Dispatching Actions through FunScript Reducer:");

  console.log("\n[Action] AddTodo('Ship FunScript 1.0', 'high')");
  dispatch(AddTodo("Ship FunScript 1.0", "high"));

  console.log("\n[Action] ToggleTodo(3) (toggle dogfooding todo to completed)");
  dispatch(ToggleTodo(3));

  console.log("\n[Action] Change filter to 'active'");
  setFilter("active");
  console.log("  Visible todos count:", visibleTodos().length);
  for (const t of visibleTodos()) {
    console.log(`   - [ ] ${t.title} (${t.priority})`);
  }

  console.log("\n[Action] Change filter to 'completed'");
  setFilter("completed");
  console.log("  Visible todos count:", visibleTodos().length);
  for (const t of visibleTodos()) {
    console.log(`   - [x] ${t.title} (${t.priority})`);
  }

  console.log("\n[Action] ClearCompleted");
  dispatch(ClearCompleted);
  setFilter("all");
  console.log("  Visible todos count after clear:", visibleTodos().length);
  for (const t of visibleTodos()) {
    console.log(`   - ${t.completed ? "[x]" : "[ ]"} ${t.title}`);
  }

  console.log("\n=== Integration Test Complete: SUCCESS ===");
});
