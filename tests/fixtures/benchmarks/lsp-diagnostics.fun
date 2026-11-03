schema User = {
  id: Number
  name: String
}

export fn formatUser(u: User) =>
  => "User #" + u.id + ": " + u.name

let legacy = true
