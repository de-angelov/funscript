import { CalculationConfig, compute } from "./math.js"

export config: CalculationConfig = {
  multiplier: 5
  offset: 10
}

export transform = (value: Number) =>
  => compute(config, value)
