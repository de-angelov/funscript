// Compliant concise function
square = (x: Number) => x * x

// Safe legacy function
increment = (x: Number) =>
  step = 1
  x + step

// Ambiguous effect block
performAction = () =>
  effect {
    result <- doTask()
    Console.log("done")
  }
