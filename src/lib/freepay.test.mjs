import test from "node:test";
import assert from "node:assert/strict";
import { shouldFallbackToFreepay } from "./freepay.ts";

test("fallback occurs only after definitive HTTP client rejection", () => {
  for (const status of [400, 401, 403, 404, 422, 499]) {
    assert.equal(shouldFallbackToFreepay(status), true, `status ${status}`);
  }
  for (const status of [200, 201, 302, 399, 500, 502, 599]) {
    assert.equal(shouldFallbackToFreepay(status), false, `status ${status}`);
  }
});
