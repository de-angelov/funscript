loadUser = (id: String) =>
  effect {
    user <- fetchUser(id)
    Console.log("fetched user")
  }
