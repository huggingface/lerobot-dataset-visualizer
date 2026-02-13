/**
 * Type guard utilities for safe type narrowing
 * Replaces unsafe type assertions throughout the codebase
 */

/**
 * Type guard for BigInt values
 *
 * @param value - Value to check
 * @returns True if value is a BigInt
 */
export function isBigInt(value: unknown): value is bigint {
  return typeof value === "bigint";
}

/**
 * Safe BigInt to number conversion
 * Handles both BigInt and number inputs gracefully
 *
 * @param value - Value to convert (can be BigInt, number, or other)
 * @param fallback - Fallback value if conversion fails (default: 0)
 * @returns Number value or fallback
 */
export function bigIntToNumber(value: unknown, fallback: number = 0): number {
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "number") {
    return value;
  }
  return fallback;
}

/**
 * Type guard for numeric values (including BigInt)
 *
 * @param value - Value to check
 * @returns True if value is a number or BigInt
 */
export function isNumeric(value: unknown): value is number | bigint {
  return typeof value === "number" || typeof value === "bigint";
}

/**
 * Type guard for valid task index
 * Ensures the value is a non-negative integer
 *
 * @param value - Value to check
 * @returns True if value is a valid task index (non-negative number)
 */
export function isValidTaskIndex(value: unknown): value is number {
  const num = bigIntToNumber(value, -1);
  return num >= 0 && Number.isInteger(num);
}

/**
 * Type guard for HTMLVideoElement
 *
 * @param element - Element to check
 * @returns True if element is an HTMLVideoElement
 */
export function isVideoElement(element: unknown): element is HTMLVideoElement {
  return element instanceof HTMLVideoElement;
}

/**
 * Safe string conversion
 * Converts any value to a string safely
 *
 * @param value - Value to convert
 * @returns String representation of the value
 */
export function toString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

/**
 * Type guard for string values
 *
 * @param value - Value to check
 * @returns True if value is a non-empty string
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Type guard for objects
 *
 * @param value - Value to check
 * @returns True if value is a non-null object
 */
export function isObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Safe property access with type guard
 * Checks if an object has a property and the property value matches the type guard
 *
 * @param obj - Object to check
 * @param key - Property key to check
 * @param typeGuard - Type guard function for the property value
 * @returns True if property exists and passes type guard
 */
export function hasPropertyOfType<T>(
  obj: unknown,
  key: string,
  typeGuard: (value: unknown) => value is T,
): obj is Record<string, unknown> & { [K in typeof key]: T } {
  return isObject(obj) && key in obj && typeGuard(obj[key]);
}
