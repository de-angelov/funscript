/** Construct JavaScript null explicitly at an interop boundary. */
export const nullValue = (): null => null;

/** Construct JavaScript undefined explicitly at an interop boundary. */
export const undefinedValue = (): undefined => undefined;

export { optionalProperties, optionalProperty, propertyPresence } from "./record.js";
