import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Exit } from "effect";
import { extractEffect, type ExtractedPage } from "./index.ts";

function client(behaviour: Record<string, unknown | Error>) {
  const calls: Array<{ url: string; options: unknown }> = [];
  return {
    calls,
    scrape: async (url: string, options: unknown) => {
      calls.push({ url, options });
      const outcome = behaviour[url];
      if (outcome instanceof Error) throw outcome;
      return { json: outcome };
    },
  };
}

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromiseExit(effect);

test("extract asks for a json format carrying the prompt and schema", async () => {
  const fake = client({ "https://a.example": { price: 10 } });
  const exit = await run(
    extractEffect(fake as never, {
      urls: ["https://a.example"],
      prompt: "the price",
      schema: { type: "object", properties: { price: { type: "number" } } },
    }),
  );
  assert.ok(Exit.isSuccess(exit));

  const options = fake.calls[0].options as {
    formats: Array<{ type: string; prompt: string; schema?: unknown }>;
    onlyMainContent: boolean;
    timeout: number;
  };
  assert.equal(options.formats[0].type, "json");
  assert.equal(options.formats[0].prompt, "the price");
  assert.deepEqual(options.formats[0].schema, {
    type: "object",
    properties: { price: { type: "number" } },
  });
  assert.equal(options.onlyMainContent, true, "main content by default");
  assert.equal(options.timeout, 60_000);
});

test("the schema key is omitted entirely when no schema is given", async () => {
  const fake = client({ "https://a.example": { x: 1 } });
  await run(
    extractEffect(fake as never, {
      urls: ["https://a.example"],
      prompt: "anything",
      onlyMainContent: false,
      timeout: 5_000,
    }),
  );
  const options = fake.calls[0].options as {
    formats: Array<Record<string, unknown>>;
    onlyMainContent: boolean;
    timeout: number;
  };
  assert.equal(Object.hasOwn(options.formats[0], "schema"), false);
  assert.equal(options.onlyMainContent, false);
  assert.equal(options.timeout, 5_000);
});

test("one failing page does not discard the pages that succeeded", async () => {
  const fake = client({
    "https://ok.example": { title: "fine" },
    "https://bad.example": new Error("502 upstream"),
  });
  const exit = await run(
    extractEffect(fake as never, {
      urls: ["https://ok.example", "https://bad.example"],
      prompt: "the title",
    }),
  );
  assert.ok(Exit.isSuccess(exit));
  const pages = (exit.value as { details: readonly ExtractedPage[] }).details;
  assert.deepEqual(
    pages.map((page) => [page.url, page.ok]),
    [
      ["https://ok.example", true],
      ["https://bad.example", false],
    ],
  );
  assert.deepEqual(pages[0].data, { title: "fine" });
  assert.match(pages[1].error ?? "", /502 upstream/);
});

test("every page failing is a real failure, not an empty success", async () => {
  const fake = client({
    "https://a.example": new Error("dns"),
    "https://b.example": new Error("timeout"),
  });
  const exit = await run(
    extractEffect(fake as never, {
      urls: ["https://a.example", "https://b.example"],
      prompt: "anything",
    }),
  );
  assert.ok(Exit.isFailure(exit));
});

test("every requested url is visited exactly once", async () => {
  const urls = ["https://1.example", "https://2.example", "https://3.example"];
  const fake = client(Object.fromEntries(urls.map((url) => [url, { url }])));
  await run(extractEffect(fake as never, { urls, prompt: "p" }));
  assert.deepEqual(fake.calls.map((call) => call.url).sort(), [...urls].sort());
  assert.equal(fake.calls.length, urls.length);
});
