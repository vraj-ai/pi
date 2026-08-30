import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { crawlEffect, pollCrawl, type CrawlClient } from "./index.ts";

test("cancels the remote crawl when polling is interrupted", async () => {
  let pollingStarted!: () => void;
  const startedPolling = new Promise<void>((resolve) => {
    pollingStarted = resolve;
  });
  const cancelledJobs: string[] = [];

  const client: CrawlClient = {
    startCrawl: async (url) => ({ id: "crawl-123", url }),
    getCrawlStatus: async () => {
      pollingStarted();
      return new Promise(() => undefined);
    },
    cancelCrawl: async (jobId) => {
      cancelledJobs.push(jobId);
      return true;
    },
  };

  const controller = new AbortController();
  const running = Effect.runPromise(
    crawlEffect(client, "https://example.com", { limit: 1 }),
    { signal: controller.signal },
  );
  const interrupted = assert.rejects(running);

  await startedPolling;
  controller.abort();
  await interrupted;

  assert.deepEqual(cancelledJobs, ["crawl-123"]);
});

test("a crawl that never leaves scraping stops after the poll cap", async () => {
  let polls = 0;
  const client: CrawlClient = {
    startCrawl: async (url) => ({ id: "crawl-cap", url }),
    getCrawlStatus: async () => {
      polls += 1;
      return { status: "scraping" } as never;
    },
    cancelCrawl: async () => true,
  };

  await assert.rejects(
    Effect.runPromise(
      pollCrawl(client, "crawl-cap", 0, { maxPolls: 3, intervalMs: 0 }),
    ),
    /after 3 status polls/,
  );
  assert.equal(polls, 3);
});

test("a completed crawl never hits the poll cap", async () => {
  let polls = 0;
  const client: CrawlClient = {
    startCrawl: async (url) => ({ id: "crawl-done", url }),
    getCrawlStatus: async () => {
      polls += 1;
      return { status: "completed", id: "crawl-done" } as never;
    },
    cancelCrawl: async () => true,
  };

  const job = await Effect.runPromise(
    pollCrawl(client, "crawl-done", 0, { maxPolls: 1, intervalMs: 0 }),
  );
  assert.equal(job.status, "completed");
  assert.equal(polls, 1);
});
