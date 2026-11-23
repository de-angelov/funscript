import { Option } from "effect";

/** Convert an optional value to an own property, preserving Some(undefined). */
export function optionalProperty<K extends PropertyKey, V>(
  key: K,
  value: Option.Option<V>,
): Partial<Record<K, V>> {
  if (Option.isNone(value)) return {};
  return { [key]: value.value } as Partial<Record<K, V>>;
}

/** Read an own property without conflating absence with a present undefined value. */
export function propertyPresence<T extends object, K extends keyof T>(
  value: T,
  key: K,
): Option.Option<T[K]> {
  return Object.prototype.hasOwnProperty.call(value, key)
    ? Option.some(value[key])
    : Option.none();
}

/** Remove known keys without mutating the input. Union members retain their individual shapes. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

export function omit<T extends object, K extends keyof T>(
  value: T,
  keys: readonly K[],
): DistributiveOmit<T, K> {
  const excluded = new Set<PropertyKey>(keys);
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    if (
      !excluded.has(key) &&
      Object.prototype.propertyIsEnumerable.call(value, key)
    ) {
      Object.defineProperty(result, key, {
        value: Reflect.get(value, key),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return result as DistributiveOmit<T, K>;
}
