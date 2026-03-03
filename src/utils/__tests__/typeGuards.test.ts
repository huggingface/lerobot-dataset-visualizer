import { describe, expect, test } from "bun:test";
import {
  isBigInt,
  bigIntToNumber,
  isNumeric,
  isValidTaskIndex,
  toString,
  isNonEmptyString,
  isObject,
  hasPropertyOfType,
} from "@/utils/typeGuards";

describe("isBigInt", () => {
  test("returns true for BigInt", () => {
    expect(isBigInt(42n)).toBe(true);
  });
  test("returns false for number", () => {
    expect(isBigInt(42)).toBe(false);
  });
  test("returns false for string", () => {
    expect(isBigInt("42")).toBe(false);
  });
  test("returns false for null", () => {
    expect(isBigInt(null)).toBe(false);
  });
});

describe("bigIntToNumber", () => {
  test("converts BigInt to number", () => {
    expect(bigIntToNumber(42n)).toBe(42);
  });
  test("passes through a regular number unchanged", () => {
    expect(bigIntToNumber(3.14)).toBe(3.14);
  });
  test("returns default fallback (0) for non-numeric value", () => {
    expect(bigIntToNumber("hello")).toBe(0);
  });
  test("returns custom fallback for non-numeric value", () => {
    expect(bigIntToNumber(null, -1)).toBe(-1);
  });
  test("converts 0n correctly", () => {
    expect(bigIntToNumber(0n)).toBe(0);
  });
  // Parquet files from v3.0 datasets return BigInt for integer columns
  test("handles large BigInt values from parquet (e.g., frame counts)", () => {
    expect(bigIntToNumber(1000000n)).toBe(1000000);
  });
});

describe("isNumeric", () => {
  test("returns true for number", () => {
    expect(isNumeric(1.5)).toBe(true);
  });
  test("returns true for BigInt (as seen in parquet columns)", () => {
    expect(isNumeric(100n)).toBe(true);
  });
  test("returns false for string", () => {
    expect(isNumeric("5")).toBe(false);
  });
  test("returns false for null", () => {
    expect(isNumeric(null)).toBe(false);
  });
  test("returns false for boolean", () => {
    expect(isNumeric(true)).toBe(false);
  });
});

describe("isValidTaskIndex", () => {
  test("returns true for 0", () => {
    expect(isValidTaskIndex(0)).toBe(true);
  });
  test("returns true for positive integer", () => {
    expect(isValidTaskIndex(5)).toBe(true);
  });
  test("returns true for BigInt 0n (v3 parquet style)", () => {
    expect(isValidTaskIndex(0n)).toBe(true);
  });
  test("returns false for negative number", () => {
    expect(isValidTaskIndex(-1)).toBe(false);
  });
  test("returns false for float", () => {
    expect(isValidTaskIndex(1.5)).toBe(false);
  });
  test("returns false for null", () => {
    expect(isValidTaskIndex(null)).toBe(false);
  });
  test("returns false for undefined", () => {
    expect(isValidTaskIndex(undefined)).toBe(false);
  });
});

describe("toString", () => {
  test("returns string as-is", () => {
    expect(toString("hello")).toBe("hello");
  });
  test("returns empty string for null", () => {
    expect(toString(null)).toBe("");
  });
  test("returns empty string for undefined", () => {
    expect(toString(undefined)).toBe("");
  });
  test("converts number to string", () => {
    expect(toString(42)).toBe("42");
  });
  test("converts BigInt to string", () => {
    expect(toString(7n)).toBe("7");
  });
});

describe("isNonEmptyString", () => {
  test("returns true for non-empty string", () => {
    expect(isNonEmptyString("hello")).toBe(true);
  });
  test("returns false for empty string", () => {
    expect(isNonEmptyString("")).toBe(false);
  });
  test("returns false for number", () => {
    expect(isNonEmptyString(5)).toBe(false);
  });
  test("returns false for null", () => {
    expect(isNonEmptyString(null)).toBe(false);
  });
});

describe("isObject", () => {
  test("returns true for plain object", () => {
    expect(isObject({ a: 1 })).toBe(true);
  });
  test("returns false for null (typeof null === 'object' trap)", () => {
    expect(isObject(null)).toBe(false);
  });
  test("returns false for array", () => {
    expect(isObject([1, 2])).toBe(false);
  });
  test("returns false for string", () => {
    expect(isObject("hello")).toBe(false);
  });
  test("returns true for empty object", () => {
    expect(isObject({})).toBe(true);
  });
});

describe("hasPropertyOfType", () => {
  test("returns true when property exists and passes type guard", () => {
    expect(
      hasPropertyOfType(
        { x: 42 },
        "x",
        (v): v is number => typeof v === "number",
      ),
    ).toBe(true);
  });
  test("returns false when property exists but fails type guard", () => {
    expect(
      hasPropertyOfType(
        { x: "hello" },
        "x",
        (v): v is number => typeof v === "number",
      ),
    ).toBe(false);
  });
  test("returns false when property does not exist", () => {
    expect(
      hasPropertyOfType(
        { a: 1 },
        "b",
        (v): v is number => typeof v === "number",
      ),
    ).toBe(false);
  });
  test("returns false for non-object input", () => {
    expect(
      hasPropertyOfType(null, "x", (v): v is number => typeof v === "number"),
    ).toBe(false);
  });
});
