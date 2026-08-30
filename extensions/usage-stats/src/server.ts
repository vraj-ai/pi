/**
 * Local HTTP server for the usage dashboard.
 *
 * Ported from `packages/stats/src/server.ts` in oh-my-pi
 * (https://github.com/can1357/oh-my-pi), MIT, (c) Can Boluk and Stencil Labs, Inc. The route
 * set matches upstream; the implementation is `node:http` and the client is the
 * self-contained page from ./client.ts.
 *
 * It binds to loopback only. This data is a complete record of what the user
 * has been working on, and it is not going on the network.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  behavior,
  costs,
  errors,
  gain,
  modelDashboard,
  overview,
  parseRange,
  projectsDashboard,
  providers,
  requests,
  runSync,
  status,
  tools,
  type StatsContext,
} from "./api.ts";
import { dashboardHtml } from "./client.ts";

export const DEFAULT_PORT = 3847;
const HOST = "127.0.0.1";
const MAX_LIMIT = 1_000;

function limitOf(url: URL, fallback: number) {
  const raw = Number(url.searchParams.get("limit"));
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(MAX_LIMIT, Math.floor(raw));
}

/**
 * Route one request. Extracted from the server so the whole API surface is
 * testable without binding a port.
 */
export function handle(
  context: StatsContext,
  method: string,
  rawUrl: string,
): { status: number; type: string; body: string } {
  const url = new URL(rawUrl, "http://localhost");
  const path = url.pathname;
  const range = parseRange(url.searchParams.get("range"));
  const json = (value: unknown) => ({
    status: 200,
    type: "application/json; charset=utf-8",
    body: JSON.stringify(value),
  });

  if (path === "/" || path === "/index.html") {
    return {
      status: 200,
      type: "text/html; charset=utf-8",
      body: dashboardHtml(),
    };
  }

  if (method === "POST" && path === "/api/sync") {
    return json(runSync(context));
  }

  if (method !== "GET") {
    return {
      status: 405,
      type: "application/json; charset=utf-8",
      body: JSON.stringify({ error: "method not allowed" }),
    };
  }

  switch (path) {
    case "/api/status":
      return json(status(context));
    case "/api/stats":
    case "/api/stats/overview":
      return json(overview(context, range));
    case "/api/stats/model-dashboard":
    case "/api/stats/models":
      return json(modelDashboard(context, range));
    case "/api/stats/costs":
      return json(costs(context, range));
    case "/api/stats/behavior":
      return json(behavior(context, range));
    case "/api/stats/tools":
      return json(tools(context, range));
    case "/api/stats/providers":
      return json(providers(context, range));
    case "/api/stats/recent":
      return json(requests(context, range, limitOf(url, 100)));
    case "/api/stats/errors":
      return json(errors(context, range, limitOf(url, 100)));
    case "/api/stats/folders":
    case "/api/stats/projects":
      return json(projectsDashboard(context, range));
    case "/api/stats/timeseries":
      return json(overview(context, range).timeSeries);
    case "/api/stats/gain":
      return json(gain(context, range, url.searchParams.get("project")));
    default:
      break;
  }

  if (path.startsWith("/api/request/")) {
    const id = Number(path.slice("/api/request/".length));
    const row = Number.isFinite(id) ? context.db.messageById(id) : null;
    if (!row) {
      return {
        status: 404,
        type: "application/json; charset=utf-8",
        body: JSON.stringify({ error: "not found" }),
      };
    }
    return json(row);
  }

  return {
    status: 404,
    type: "application/json; charset=utf-8",
    body: JSON.stringify({ error: "not found" }),
  };
}

export interface RunningServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Start the dashboard. `port: 0` asks the OS for a free port, which is what
 * tests use and what a second concurrent dashboard falls back to.
 */
export function startServer(
  context: StatsContext,
  port: number = DEFAULT_PORT,
): Promise<RunningServer> {
  const server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      let result: ReturnType<typeof handle>;
      try {
        result = handle(context, request.method ?? "GET", request.url ?? "/");
      } catch (error) {
        result = {
          status: 500,
          type: "application/json; charset=utf-8",
          body: JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        };
      }
      response.writeHead(result.status, {
        "content-type": result.type,
        // Loopback-only, but a browser tab from another origin must still not be
        // able to read a full record of the user's work.
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(result.body);
    },
  );

  return new Promise<RunningServer>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener("error", onError);
      if (error.code === "EADDRINUSE" && port !== 0) {
        // Another dashboard already owns the default port; take any free one
        // rather than failing the command.
        startServer(context, 0).then(resolve, reject);
        return;
      }
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, HOST, () => {
      server.removeListener("error", onError);
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://${HOST}:${address.port}`,
        port: address.port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}
