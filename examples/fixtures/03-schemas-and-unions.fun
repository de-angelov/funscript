# Fixture 03: Schemas and Tagged Unions

import { Option } from "effect"

export schema User = {
  id: string
  name: string
  role: string = "member"
  bio: Option<string>
}

export schema Shape =
  | Circle(radius: number)
  | Rect(width: number, height: number)
  | Point

export c = Circle(10)
export r = Rect(20, 30)
export p = Point
