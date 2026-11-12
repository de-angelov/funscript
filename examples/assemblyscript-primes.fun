// Keep the loop inside Wasm so each call does useful work at the boundary.
as {
  export function countPrimes(limit: i32): i32 {
    let count: i32 = 0;
    for (let n: i32 = 2; n <= limit; n++) {
      let prime = true;
      for (let divisor: i32 = 2; divisor <= n / divisor; divisor++) {
        if (n % divisor == 0) {
          prime = false;
          break;
        }
      }
      if (prime) count++;
    }
    return count;
  }
}

export primesBelow100 = countPrimes(100)
export primesBelow1000 = countPrimes(1000)
