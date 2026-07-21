import { describe, expect, it } from "vitest";
import { cosineDistance } from "../src/utils/vector.js";

describe("cosineDistance", () => {
  it("throws on dimension mismatch", () => {
    const a = Float32Array.from([1, 0, 0]);
    const b = Float32Array.from([1, 0]);
    expect(() => cosineDistance(a, b)).toThrow(/dimension mismatch/i);
  });
});

