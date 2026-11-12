// Numeric kernels run in WebAssembly and can be called from FunScript.
// The .effect companion validates numeric inputs and captures Wasm traps.

as {
  export function wilsonScore(ups: f64, downs: f64): f64 {
    const total = ups + downs;
    if (total == 0.0) return 0.0;
    const z: f64 = 1.96;
    const p = ups / total;
    const z2 = z * z;
    return (p + z2 / (2.0 * total) - z * Math.sqrt((p * (1.0 - p) + z2 / (4.0 * total)) / total)) / (1.0 + z2 / total);
  }

  export function divideIntegers(a: i32, b: i32): i32 {
    return a / b;
  }
}

export score = wilsonScore(120, 15)

export safeDivide = (numerator: Number, denominator: Number) =>
  divideIntegers.effect(numerator, denominator)
