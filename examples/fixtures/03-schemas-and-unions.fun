# Fixture 03: Schemas and Tagged Unions

import { Option } from "effect"

export schema User = {
  id: String
  name: String
  role: String = "member"
  bio: Option<String>
}

export schema Shape =
  | Circle(radius: Number)
  | Rect(width: Number, height: Number)
  | Point

export c = Circle(10)
export r = Rect(20, 30)
export p = Point
