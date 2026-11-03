export schema CalculationConfig = {
  multiplier: Number
  offset: Number
}

export fn compute(config: CalculationConfig, input: Number) =>
  => config.multiplier * input + config.offset
