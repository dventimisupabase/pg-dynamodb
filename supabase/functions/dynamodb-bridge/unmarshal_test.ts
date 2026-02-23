import { assertEquals } from "jsr:@std/assert";
import { unmarshalValue, unmarshalItem } from "./unmarshal.ts";

Deno.test("unmarshalValue: string (S)", () => {
  assertEquals(unmarshalValue({ S: "hello" }), "hello");
});

Deno.test("unmarshalValue: number (N) - integer", () => {
  assertEquals(unmarshalValue({ N: "42" }), 42);
});

Deno.test("unmarshalValue: number (N) - float", () => {
  assertEquals(unmarshalValue({ N: "3.14" }), 3.14);
});

Deno.test("unmarshalValue: number (N) - negative", () => {
  assertEquals(unmarshalValue({ N: "-100" }), -100);
});

Deno.test("unmarshalValue: boolean true (BOOL)", () => {
  assertEquals(unmarshalValue({ BOOL: true }), true);
});

Deno.test("unmarshalValue: boolean false (BOOL)", () => {
  assertEquals(unmarshalValue({ BOOL: false }), false);
});

Deno.test("unmarshalValue: null (NULL)", () => {
  assertEquals(unmarshalValue({ NULL: true }), null);
});

Deno.test("unmarshalValue: list (L) - flat", () => {
  assertEquals(
    unmarshalValue({ L: [{ S: "a" }, { N: "1" }, { BOOL: true }] }),
    ["a", 1, true],
  );
});

Deno.test("unmarshalValue: list (L) - nested", () => {
  assertEquals(
    unmarshalValue({ L: [{ L: [{ S: "inner" }] }] }),
    [["inner"]],
  );
});

Deno.test("unmarshalValue: list (L) - empty", () => {
  assertEquals(unmarshalValue({ L: [] }), []);
});

Deno.test("unmarshalValue: map (M) - flat", () => {
  assertEquals(
    unmarshalValue({ M: { name: { S: "Alice" }, age: { N: "30" } } }),
    { name: "Alice", age: 30 },
  );
});

Deno.test("unmarshalValue: map (M) - nested", () => {
  assertEquals(
    unmarshalValue({
      M: {
        address: {
          M: { city: { S: "NYC" }, zip: { S: "10001" } },
        },
      },
    }),
    { address: { city: "NYC", zip: "10001" } },
  );
});

Deno.test("unmarshalValue: map (M) - empty", () => {
  assertEquals(unmarshalValue({ M: {} }), {});
});

Deno.test("unmarshalValue: string set (SS)", () => {
  assertEquals(
    unmarshalValue({ SS: ["a", "b", "c"] }),
    ["a", "b", "c"],
  );
});

Deno.test("unmarshalValue: number set (NS)", () => {
  assertEquals(
    unmarshalValue({ NS: ["1", "2", "3"] }),
    [1, 2, 3],
  );
});

Deno.test("unmarshalValue: binary (B) - passthrough as base64", () => {
  assertEquals(unmarshalValue({ B: "dGVzdA==" }), "dGVzdA==");
});

Deno.test("unmarshalValue: binary set (BS) - passthrough as base64 array", () => {
  assertEquals(
    unmarshalValue({ BS: ["dGVzdA==", "YWJj"] }),
    ["dGVzdA==", "YWJj"],
  );
});

Deno.test("unmarshalItem: full item", () => {
  const dynamoItem = {
    pk: { S: "USER#123" },
    sk: { S: "PROFILE" },
    name: { S: "Alice" },
    score: { N: "42" },
    active: { BOOL: true },
    tags: { SS: ["admin", "user"] },
    metadata: { M: { created: { S: "2024-01-01" } } },
  };
  assertEquals(unmarshalItem(dynamoItem), {
    pk: "USER#123",
    sk: "PROFILE",
    name: "Alice",
    score: 42,
    active: true,
    tags: ["admin", "user"],
    metadata: { created: "2024-01-01" },
  });
});

Deno.test("unmarshalItem: empty item", () => {
  assertEquals(unmarshalItem({}), {});
});

Deno.test("unmarshalValue: unknown type throws", () => {
  let threw = false;
  try {
    // deno-lint-ignore no-explicit-any
    unmarshalValue({ UNKNOWN: "bad" } as any);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});
