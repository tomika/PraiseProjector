/**
 * Deep copy of JSON data (stored entries). Used instead of structuredClone,
 * which older Android WebViews (Chrome < 98) and Safari < 15.4 do not have.
 */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
