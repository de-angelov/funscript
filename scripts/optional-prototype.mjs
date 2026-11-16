// THROWAWAY: Does accepting values and forwarding Options simplify real call sites
// without losing the distinction between an Option payload and an optional argument?
// This simulates proposed semantics; it does not modify or exercise the compiler.
import readline from "node:readline";
import { inspectScenario, scenarios } from "./optional-prototype-model.mjs";

let index = 0;
const input = readline.createInterface({ input: process.stdin, output: process.stdout });
function render() {
  if (process.stdout.isTTY) console.clear();
  const { name, target, input: argument, current, proposed, proposedResult } = inspectScenario(index);
  console.log(`\x1b[1mOptional values prototype (${index + 1}/${scenarios.length})\x1b[0m\n`);
  console.log(JSON.stringify({ scenario: name, target, argument, current, proposed, proposedResult }, null, 2));
  console.log("\n[n] next  [p] previous  [1-8] select  [q] quit");
}
render();
input.on("line", (line) => {
  const action = line.trim();
  if (action === "q") return input.close();
  if (action === "n") index = (index + 1) % scenarios.length;
  if (action === "p") index = (index + scenarios.length - 1) % scenarios.length;
  if (/^[1-8]$/.test(action)) index = Number(action) - 1;
  render();
});
