buildRecord = (id: String, name: String) =>
  trimmed = name |> String.trim()
  user = { id, name: trimmed }
