# Program 06: Markdown Task Manager CLI & State Engine
# Demonstrates:
# 1. Mutative 'draft' state recipes for immutable task list updates
# 2. 'when' early returns: 'when (cond) => expr'
# 3. 'when' conditional execution blocks: 'when (cond) { ... }'
# 4. Explicit return statements: '=> expr'
# 5. Effect file system I/O via 'js' Promise interop

import { Console } from "effect"

# --- Domain Data Model & Schemas ---

export schema Task = {
  id: number
  title: string
  completed: boolean
  tag: string
}

export schema TaskManager = ts "{ tasks: Task[]; nextId: number; }"

# --- File System I/O Helpers via TypeScript Interop ---

ts
  import * as fs from "node:fs/promises";

  export async function writeTaskFile(filePath: string, content: string): Promise<boolean> {
    await fs.writeFile(filePath, content, "utf-8");
    return true;
  }

  export async function readTaskFile(filePath: string): Promise<string> {
    try {
      return await fs.readFile(filePath, "utf-8");
    } catch {
      return "";
    }
  }

  export async function deleteTaskFile(filePath: string): Promise<boolean> {
    try {
      await fs.unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }

# --- Pure Domain Operations (Mutative & Control Flow) ---

export emptyManager: TaskManager = {
  tasks: [],
  nextId: 1
}

# 1. addTask with 'when' early return, Mutative draft array update, and explicit return '=>'
export addTask = (manager: TaskManager, title: string, tag: string) => {
  # Early return guard for invalid/empty title
  when (title == "") => manager

  newId = manager.nextId
  newTask: Task = {
    id: newId,
    title,
    completed: false,
    tag
  }

  # Mutative draft scope updating task collection
  updatedTasks = manager.tasks |> mut (draft) ->
    draft.push(newTask)
    draft

  updated = {
    ...manager,
    tasks: updatedTasks,
    nextId: newId + 1
  }

  # Explicit return statement
  => updated
}

# 2. completeTask with 'when' early return and block 'when' condition
export completeTask = (manager: TaskManager, targetId: number) => {
  # Early return when collection is empty
  when (manager.tasks.length == 0) => manager

  updatedTasks = manager.tasks |> mut (draft) ->
    idx = draft.findIndex((t) -> t.id == targetId)
    # Conditional block execution form
    when (idx != -1) {
      existing = draft[idx]
      updatedItem = { ...existing, completed: true }
      draft.splice(idx, 1, updatedItem)
    }
    draft

  updated = { ...manager, tasks: updatedTasks }
  => updated
}

# 3. removeTask with block 'when'
export removeTask = (manager: TaskManager, targetId: number) => {
  when (manager.tasks.length == 0) => manager

  updatedTasks = manager.tasks |> mut (draft) ->
    idx = draft.findIndex((t) -> t.id == targetId)
    when (idx != -1) {
      draft.splice(idx, 1)
    }
    draft

  updated = { ...manager, tasks: updatedTasks }
  => updated
}

# 4. Markdown Formatter and Serializer
export formatTaskLine = (task: Task) => {
  marker = match
    | task.completed == true -> "[x]"
    | _ -> "[ ]"
  => "- " + marker + " #" + task.id + ": " + task.title + " (tag: #" + task.tag + ")"
}

export serializeToMarkdown = (manager: TaskManager) => {
  # Early return for empty task manager
  when (manager.tasks.length == 0) => "# Task List\n\nNo active tasks.\n"

  lines = manager.tasks |> map(formatTaskLine) |> join("\n")
  => "# Task List\n\n" + lines + "\n"
}

# --- Effect File System I/O Workflows ---

export saveTasks = (filePath: string, manager: TaskManager) =>
  effect
    md = serializeToMarkdown(manager)
    _ <- js writeTaskFile(filePath, md)
    _ <- Console.log("[TaskManager] Successfully persisted " + manager.tasks.length + " tasks to " + filePath)
    md

export loadTasks = (filePath: string) =>
  effect
    content <- js readTaskFile(filePath)
    _ <- Console.log("[TaskManager] Loaded markdown file from " + filePath + " (" + content.length + " bytes)")
    content

# --- Main CLI Flow ---

export main =
  effect
    _ <- Console.log("=== Markdown Task Manager Starting ===")

    # 1. Initialize empty manager and add tasks
    m0 = emptyManager
    m1 = addTask(m0, "Set up FunScript dogfood suite", "dev")
    m2 = addTask(m1, "Stress-test Mutative draft updates", "compiler")
    m3 = addTask(m2, "Document findings in docs/DOGFOODING.md", "docs")
    m4 = addTask(m3, "", "ignored") # should be skipped by early return

    _ <- Console.log("[TaskManager] Initialized 3 tasks.")

    # 2. Complete tasks #1 and #2
    m5 = completeTask(m4, 1)
    m6 = completeTask(m5, 2)

    # 3. Serialize and save to disk
    filePath = ".funscript-cache/tasks-dogfood.md"
    _ <- saveTasks(filePath, m6)

    # 4. Read back and verify output
    savedContent <- loadTasks(filePath)
    _ <- Console.log("--- Persisted Markdown Content ---")
    _ <- Console.log(savedContent)

    # 5. Clean up temporary test file
    _ <- js deleteTaskFile(filePath)
    _ <- Console.log("[TaskManager] Cleaned up temporary test file.")
    _ <- Console.log("=== Markdown Task Manager Completed Successfully ===")
    0
