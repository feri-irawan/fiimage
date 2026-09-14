import { describe, expect, test } from "bun:test";
import { generationGate } from "../lib/concurrency";

describe("generation concurrency", () => {
  test("limits work per function instance and releases slots safely", () => {
    const first = generationGate.tryAcquire();
    const second = generationGate.tryAcquire();

    expect(first).toBeFunction();
    expect(second).toBeFunction();
    expect(generationGate.tryAcquire()).toBeUndefined();

    first?.();
    first?.();
    expect(generationGate.tryAcquire()).toBeFunction();

    second?.();
    const final = generationGate.tryAcquire();
    expect(final).toBeFunction();
    final?.();
  });
});
