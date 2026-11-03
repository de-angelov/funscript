import { CalculationConfig, compute } from "./math.js"

export config: CalculationConfig = {
  multiplier: 5
  offset: 10
}

export fn transform(value: Number) =>
  => compute(config, value)
