import { test } from "node:test";
import assert from "node:assert/strict";
import { add, isEven } from "../src/math.js";

test("add", () => { assert.equal(add(2, 3), 5); });
test("isEven", () => { assert.equal(isEven(4), true); assert.equal(isEven(7), false); });
