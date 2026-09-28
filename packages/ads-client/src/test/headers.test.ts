import test from "node:test";
import assert from "node:assert";
import { buildAdsHeaders, assertCustomerId } from "../headers.js";

test("dual-ID headers: bearer + digits-only login-customer-id, dashes rejected", () => {
  const h = buildAdsHeaders({ accessToken: "tok", loginCustomerId: "1234567890", customerId: "9876543210" });
  assert.strictEqual(h["Authorization"], "Bearer tok");
  assert.strictEqual(h["login-customer-id"], "1234567890");
  assert.throws(() => buildAdsHeaders({ accessToken: "tok", loginCustomerId: "123-456-7890", customerId: "1" }), /digits/i);
  assert.throws(() => buildAdsHeaders({ accessToken: "tok", customerId: "98-76" }), /digits/i);
});

test("exception endpoint shape: discovery call omits login-customer-id pre-validation", () => {
  const h = buildAdsHeaders({ accessToken: "tok", customerId: "555" });
  assert.ok(!("login-customer-id" in h), "listAccessibleCustomers must carry no login header");
});

test("assertCustomerId accepts digit strings, rejects everything else", () => {
  assert.strictEqual(assertCustomerId("1234567890"), "1234567890");
  assert.throws(() => assertCustomerId("abc"));
  assert.throws(() => assertCustomerId("123 456"));
});
