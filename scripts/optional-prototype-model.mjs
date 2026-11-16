// THROWAWAY: compare optional forwarding with the current calling convention.
import { Option } from "effect";

export const scenarios = [
  { name: "Home loader: omitted options", target: "options?: Options", input: "omitted", current: "readCountriesWithVoteTotals()", proposed: "readCountriesWithVoteTotals()", value: undefined, kind: "omitted" },
  { name: "Home loader: supplied options", target: "options?: Options", input: "{ fixtures: [...] }", current: "readCountriesWithVoteTotals(options)", proposed: "readCountriesWithVoteTotals(options)", value: { fixtures: ["BG"] }, kind: "value" },
  { name: "Home loader: forward optional options", target: "options?: Options", input: "Option<Options>", current: "readCountriesWithVoteTotals(Option.getOrUndefined(options))", proposed: "readCountriesWithVoteTotals(options)", value: Option.some({ fixtures: ["BG"] }), kind: "forward" },
  { name: "Home loader: forward missing options", target: "options?: Options", input: "Option<Options> = None", current: "readCountriesWithVoteTotals(Option.getOrUndefined(options))", proposed: "readCountriesWithVoteTotals(options)", value: Option.none(), kind: "forward" },
  { name: "JavaScript caller: ordinary options", target: "options?: Options", input: "JS: { fixtures: [...] }", current: "readCountriesWithVoteTotals({ fixtures: [...] })", proposed: "readCountriesWithVoteTotals({ fixtures: [...] })", value: { fixtures: ["BG"] }, kind: "value" },
  { name: "Unknown payload: is an Option a value?", target: "value?: Unknown", input: "Option<String>", current: "inspect(option) => Some(option)", proposed: "inspect(option) => diagnostic; choose value or forwarding", kind: "ambiguous" },
  { name: "Nested Option: supplied None or omitted?", target: "value?: Option<String>", input: "Option<String> = None", current: "inspect(None) => Some(None)", proposed: "inspect(None) => diagnostic; choose value or forwarding", kind: "ambiguous" },
  { name: "Nested Option: explicitly supply None", target: "value?: Option<String>", input: "Some(None): Option<Option<String>>", current: "inspect(None)", proposed: "inspect(Some(None))", value: Option.some(Option.none()), kind: "forward" },
];

export function inspectScenario(index) {
  const scenario = scenarios[index];
  const result = scenario.kind === "ambiguous" ? "diagnostic: explicitly choose value or forwarding"
    : scenario.kind === "forward" ? scenario.value
    : Option.fromUndefinedOr(scenario.value);
  return { ...scenario, value: undefined, proposedResult: result };
}
