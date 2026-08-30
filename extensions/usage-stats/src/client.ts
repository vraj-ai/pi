/**
 * The dashboard page, as one self-contained HTML string.
 *
 * Reworked from `packages/stats/src/client/**` in oh-my-pi
 * (https://github.com/can1357/oh-my-pi), MIT, (c) Can Boluk and Stencil Labs,
 * Inc. The section list, the range list, and the metrics each page shows follow
 * upstream; none of upstream's React source is reused.
 *
 * Upstream ships a React + Chart.js + Tailwind bundle built by a separate
 * toolchain. This port keeps the same ten sections and six ranges but renders
 * them with plain DOM and inline SVG, because adding a bundler to a repo whose
 * only build step is `tsc --noEmit` would cost far more than the charts are
 * worth. No network requests leave the machine: the page talks only to the
 * local server that served it.
 */

const SECTIONS = [
  ["overview", "Overview"],
  ["requests", "Requests"],
  ["errors", "Errors"],
  ["models", "Models"],
  ["providers", "Providers"],
  ["tools", "Tools"],
  ["costs", "Costs"],
  ["behavior", "Behavior"],
  ["projects", "Projects"],
  ["gain", "Gain"],
] as const;

export const DASHBOARD_SECTIONS = SECTIONS.map(([id]) => id);

const STYLE = `
:root {
  color-scheme: dark;
  --bg: #00131f; --panel: #001a2b; --surface: #002236; --border: #0d3a55;
  --text: #e8f4ff; --muted: #7fa6c4; --dim: #4d738f;
  --accent: #39d7ff; --cobalt: #0f7fd4; --mint: #3ce6b0; --amber: #ffc763; --red: #ff5d6e;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
header { display: flex; flex-wrap: wrap; gap: 12px; align-items: center;
  padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--panel);
  position: sticky; top: 0; z-index: 2; }
h1 { font-size: 15px; margin: 0 12px 0 0; color: var(--accent); font-weight: 600; }
nav { display: flex; flex-wrap: wrap; gap: 4px; }
button { background: var(--surface); color: var(--muted); border: 1px solid var(--border);
  border-radius: 4px; padding: 4px 10px; cursor: pointer; font: inherit; font-size: 12px; }
button:hover { color: var(--text); border-color: var(--cobalt); }
button[aria-current="true"] { background: var(--cobalt); color: #fff; border-color: var(--cobalt); }
main { padding: 16px; }
section h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em;
  color: var(--muted); margin: 24px 0 8px; }
section h2:first-child { margin-top: 0; }
.cards { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; }
.card .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
.card .value { font-size: 20px; margin-top: 4px; }
.card .note { color: var(--dim); font-size: 11px; margin-top: 2px; }
table { width: 100%; border-collapse: collapse; font-size: 12px;
  background: var(--panel); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
th, td { padding: 6px 10px; text-align: right; border-bottom: 1px solid var(--border); white-space: nowrap; }
th:first-child, td:first-child { text-align: left; }
th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover { background: var(--surface); }
.scroll { overflow-x: auto; }
.empty { color: var(--dim); padding: 16px 0; }
.err { color: var(--red); }
.tag { font-size: 10px; padding: 1px 5px; border-radius: 3px; border: 1px solid var(--border); color: var(--muted); }
.tag.reported { color: var(--mint); border-color: var(--mint); }
.tag.estimated { color: var(--amber); border-color: var(--amber); }
.note-line { color: var(--dim); font-size: 12px; margin: 6px 0 10px; }
svg { display: block; width: 100%; height: 140px; background: var(--panel);
  border: 1px solid var(--border); border-radius: 6px; }
#status { margin-left: auto; color: var(--dim); font-size: 12px; }
`;

/**
 * The whole client. Written as a string rather than a bundled module so the
 * server has no build step and the page has no external dependency.
 */
const SCRIPT = String.raw`
const SECTIONS = ${JSON.stringify(SECTIONS)};
const RANGES = ["1h", "24h", "7d", "30d", "90d", "all"];
const state = { section: "overview", range: "7d" };

const $ = (tag, attrs = {}, children = []) => {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "text") el.textContent = value;
    else if (key === "class") el.className = value;
    else if (value !== undefined && value !== null) el.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child) el.append(child);
  return el;
};

const fmtTokens = n => {
  n = Math.round(Number(n) || 0);
  const a = Math.abs(n);
  if (a < 1000) return String(n);
  if (a < 1e6) return (n / 1e3).toFixed(1) + "k";
  return (n / 1e6).toFixed(2) + "M";
};
const fmtCost = n => {
  n = Number(n) || 0;
  return n > 0 && n < 0.01 ? "<$0.01" : "$" + n.toFixed(2);
};
const fmtPct = n => (n === null || n === undefined || !isFinite(n) ? "n/a" : (n * 100).toFixed(1) + "%");
const fmtRate = n => (n === null || n === undefined || !isFinite(n) ? "n/a" : n.toFixed(1) + " tok/s");
const fmtMs = n => (n === null || n === undefined || !isFinite(n) ? "n/a" : n >= 1000 ? (n / 1000).toFixed(1) + "s" : Math.round(n) + "ms");
const fmtTime = ms => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

function card(label, value, note) {
  return $("div", { class: "card" }, [
    $("div", { class: "label", text: label }),
    $("div", { class: "value", text: value }),
    note ? $("div", { class: "note", text: note }) : null,
  ]);
}

function table(headers, rows) {
  if (!rows.length) return $("div", { class: "empty", text: "No data in this range." });
  const thead = $("thead", {}, $("tr", {}, headers.map(h => $("th", { text: h }))));
  const tbody = $("tbody", {}, rows.map(cells =>
    $("tr", {}, cells.map(cell =>
      cell && typeof cell === "object" && cell.node ? $("td", {}, cell.node) : $("td", { text: String(cell ?? "") })))));
  return $("div", { class: "scroll" }, $("table", {}, [thead, tbody]));
}

/** Minimal inline sparkline/bar chart: enough to see shape, no dependency. */
function chart(points, valueOf, labelOf) {
  if (!points.length) return $("div", { class: "empty", text: "No data in this range." });
  const values = points.map(valueOf);
  const max = Math.max(...values, 1);
  const width = 1000, height = 140, pad = 8;
  const step = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;
  const path = points
    .map((p, i) => (i ? "L" : "M") + (pad + i * step).toFixed(1) + " " +
      (height - pad - (values[i] / max) * (height - pad * 2)).toFixed(1))
    .join(" ");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 " + width + " " + height);
  svg.setAttribute("preserveAspectRatio", "none");
  const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
  line.setAttribute("d", path);
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "#39d7ff");
  line.setAttribute("stroke-width", "2");
  svg.append(line);
  const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
  title.textContent = points.map((p, i) => labelOf(p) + ": " + values[i]).join("\n");
  svg.append(title);
  return svg;
}

async function api(path, params = {}) {
  const url = new URL(path, location.origin);
  url.searchParams.set("range", state.range);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url);
  if (!response.ok) throw new Error(path + ": " + response.status + " " + (await response.text()));
  return response.json();
}

const renderers = {
  async overview(root) {
    const data = await api("/api/stats/overview");
    const o = data.overall;
    root.append(
      $("h2", { text: "Overall" }),
      $("div", { class: "cards" }, [
        card("Requests", String(o.totalRequests), o.failedRequests + " failed"),
        card("Error rate", fmtPct(o.errorRate)),
        card("Cost", fmtCost(o.totalCost), o.unpricedRequests + " unpriced"),
        card("Input tokens", fmtTokens(o.totalInputTokens)),
        card("Output tokens", fmtTokens(o.totalOutputTokens)),
        card("Cache rate", fmtPct(o.cacheRate), "saved " + fmtPct(o.cacheSavings)),
        card("Throughput", fmtRate(o.avgTokensPerSecond), "derived"),
        card("Avg latency", fmtMs(o.avgDuration), "derived, includes tool time"),
      ]),
      $("h2", { text: "Activity" }),
      chart(data.timeSeries, p => p.requests, p => fmtTime(p.timestamp)),
      $("h2", { text: "By model" }),
      table(["Model", "Provider", "Requests", "Errors", "Tokens", "Cost", "tok/s"],
        data.byModel.map(m => [m.model, m.provider, m.totalRequests, m.failedRequests,
          fmtTokens(m.totalInputTokens + m.totalOutputTokens + m.totalCacheReadTokens + m.totalCacheWriteTokens),
          fmtCost(m.totalCost), fmtRate(m.avgTokensPerSecond)])),
      $("h2", { text: "By agent" }),
      table(["Agent", "Requests", "Tokens", "Cost"],
        data.byAgentType.map(a => [a.agentType, a.totalRequests,
          fmtTokens(a.totalInputTokens + a.totalOutputTokens), fmtCost(a.totalCost)])),
    );
  },

  async requests(root) {
    const rows = await api("/api/stats/recent", { limit: 200 });
    root.append($("h2", { text: "Recent requests" }),
      table(["When", "Model", "Stop", "Tokens", "Cost", "Latency", "Project"],
        rows.map(r => [fmtTime(r.timestamp), r.model, r.stopReason, fmtTokens(r.totalTokens),
          fmtCost(r.costTotal), fmtMs(r.duration), r.folder])));
  },

  async errors(root) {
    const rows = await api("/api/stats/errors", { limit: 200 });
    root.append($("h2", { text: "Errors" }),
      table(["When", "Model", "Provider", "Message", "Project"],
        rows.map(r => [fmtTime(r.timestamp), r.model, r.provider,
          { node: $("span", { class: "err", text: r.errorMessage || r.stopReason }) }, r.folder])));
  },

  async models(root) {
    const data = await api("/api/stats/model-dashboard");
    root.append(
      $("h2", { text: "Models" }),
      table(["Model", "Provider", "Requests", "Tokens in", "Tokens out", "Reasoning", "Cost", "tok/s", "Cache"],
        data.byModel.map(m => [m.model, m.provider, m.totalRequests, fmtTokens(m.totalInputTokens),
          fmtTokens(m.totalOutputTokens), fmtTokens(m.totalReasoningTokens), fmtCost(m.totalCost),
          fmtRate(m.avgTokensPerSecond), fmtPct(m.cacheRate)])),
      $("h2", { text: "Throughput over time" }),
      table(["Bucket", "Model", "Requests", "tok/s"],
        data.performance.map(p => [fmtTime(p.timestamp), p.model, p.requests, fmtRate(p.avgTokensPerSecond)])),
    );
  },

  async providers(root) {
    const data = await api("/api/stats/providers");
    root.append(
      $("h2", { text: "Providers" }),
      table(["Provider", "Requests", "Failed", "Models", "Tokens", "Cost", "tok/s"],
        data.providers.map(p => [p.provider, p.totalRequests, p.failedRequests, p.models,
          fmtTokens(p.totalTokens), fmtCost(p.totalCost), fmtRate(p.avgTokensPerSecond)])),
      $("h2", { text: "Subscription limits" }),
      $("div", { class: "note-line", text:
        "reported = the provider's own rate-limit headers. estimated = inferred from burn against a configured budget." }),
      table(["Provider", "Window", "Source", "Accounts", "Windows burned", "Est tokens/window", "Peak concurrent", "Ideal accounts", "Exhausted"],
        data.windowInsights.map(w => [w.provider, w.windowLabel,
          { node: $("span", { class: "tag " + w.source, text: w.source }) },
          w.accounts, w.fractionConsumed.toFixed(2),
          w.estTokensPerWindow === null ? "n/a" : fmtTokens(w.estTokensPerWindow),
          fmtPct(w.peakConcurrentFraction), w.idealAccounts, w.exhaustedEvents])),
      $("h2", { text: "Peak burn hours (local)" }),
      table(["Provider", "Hour", "Tokens", "Requests"],
        data.hourly.map(h => [h.provider, String(h.hour).padStart(2, "0") + ":00",
          fmtTokens(h.totalTokens), h.requests])),
    );
  },

  async tools(root) {
    const data = await api("/api/stats/tools");
    root.append(
      $("h2", { text: "Tools" }),
      $("div", { class: "note-line", text:
        "Token and cost shares split the invoking turn's real usage evenly across that turn's calls." }),
      table(["Tool", "Calls", "Errors", "Args chars", "Result chars", "Token share", "Cost share", "Last used"],
        data.byTool.map(t => [t.tool, t.calls, t.errors, fmtTokens(t.argsChars), fmtTokens(t.resultChars),
          fmtTokens(t.totalTokensShare), fmtCost(t.costShare), t.lastUsed ? fmtTime(t.lastUsed) : "n/a"])),
      $("h2", { text: "By tool and model" }),
      table(["Tool", "Model", "Calls", "Errors", "Token share", "Cost share"],
        data.byToolModel.map(t => [t.tool, t.model, t.calls, t.errors,
          fmtTokens(t.totalTokensShare), fmtCost(t.costShare)])),
    );
  },

  async costs(root) {
    const data = await api("/api/stats/costs");
    const total = data.byModel.reduce((sum, m) => sum + m.totalCost, 0);
    root.append(
      $("h2", { text: "Cost" }),
      $("div", { class: "cards" }, [card("Total", fmtCost(total))]),
      $("h2", { text: "By model" }),
      table(["Model", "Provider", "Cost", "Share", "Input", "Output", "Cache read", "Requests", "Unpriced"],
        data.byModel.map(m => [m.model, m.provider, fmtCost(m.totalCost),
          total > 0 ? fmtPct(m.totalCost / total) : "n/a",
          fmtTokens(m.totalInputTokens), fmtTokens(m.totalOutputTokens),
          fmtTokens(m.totalCacheReadTokens), m.totalRequests, m.unpricedRequests])),
      $("h2", { text: "Cost over time" }),
      table(["Bucket", "Model", "Cost", "Requests"],
        data.series.map(s => [fmtTime(s.timestamp), s.model, fmtCost(s.cost), s.requests])),
    );
  },

  async behavior(root) {
    const data = await api("/api/stats/behavior");
    const o = data.overall;
    root.append(
      $("h2", { text: "How the conversation is going" }),
      $("div", { class: "cards" }, [
        card("User messages", String(o.messages)),
        card("Signals / 100 msgs", o.frustrationRate.toFixed(1)),
        card("Words", fmtTokens(o.words)),
        card("Yelling", String(o.yelling)),
        card("Negation", String(o.negation)),
        card("Repetition", String(o.repetition)),
        card("Blame", String(o.blame)),
        card("Profanity", String(o.profanity)),
      ]),
      $("h2", { text: "By model" }),
      table(["Model", "Messages", "Signals/100", "Negation", "Repetition", "Blame", "Yelling"],
        data.byModel.map(m => [m.model, m.messages, m.frustrationRate.toFixed(1),
          m.negation, m.repetition, m.blame, m.yelling])),
    );
  },

  async projects(root) {
    const data = await api("/api/stats/folders");
    root.append($("h2", { text: "Projects" }),
      table(["Project", "Requests", "Errors", "Tokens", "Cost", "Last active"],
        data.byFolder.map(f => [f.folder, f.totalRequests, f.failedRequests,
          fmtTokens(f.totalInputTokens + f.totalOutputTokens), fmtCost(f.totalCost),
          f.lastTimestamp ? fmtTime(f.lastTimestamp) : "n/a"])));
  },

  async gain(root) {
    const data = await api("/api/stats/gain");
    const o = data.overall;
    root.append(
      $("h2", { text: "Tokens saved" }),
      $("div", { class: "cards" }, [
        card("Saved tokens", fmtTokens(o.savedTokens)),
        card("Events", String(o.hits)),
        card("Reduction", fmtPct(o.reductionPercent)),
        card("Original bytes", fmtTokens(o.originalBytes)),
      ]),
      $("h2", { text: "By source" }),
      table(["Source", "Events", "Saved tokens", "Original", "Kept", "Reduction"],
        Object.entries(data.bySource).map(([source, t]) => [source, t.hits, fmtTokens(t.savedTokens),
          fmtTokens(t.originalBytes), fmtTokens(t.outputBytes), fmtPct(t.reductionPercent)])),
      $("h2", { text: "Daily" }),
      table(["Date", "Compression", "Compaction", "Total"],
        data.timeSeries.map(d => [d.date, fmtTokens(d.compression), fmtTokens(d.compaction), fmtTokens(d.total)])),
    );
  },
};

async function render() {
  const root = document.querySelector("main");
  root.replaceChildren($("div", { class: "empty", text: "Loading..." }));
  for (const button of document.querySelectorAll("nav button")) {
    button.setAttribute("aria-current", String(button.dataset.section === state.section));
  }
  for (const button of document.querySelectorAll("#ranges button")) {
    button.setAttribute("aria-current", String(button.dataset.range === state.range));
  }
  location.hash = state.section + "/" + state.range;
  const fresh = $("section");
  try {
    await renderers[state.section](fresh);
    root.replaceChildren(fresh);
  } catch (error) {
    root.replaceChildren($("div", { class: "empty err", text: String(error && error.message || error) }));
  }
}

function boot() {
  const [section, range] = (location.hash || "").replace(/^#/, "").split("/");
  if (renderers[section]) state.section = section;
  if (RANGES.includes(range)) state.range = range;

  const nav = $("nav", {}, SECTIONS.map(([id, label]) => {
    const button = $("button", { text: label, "data-section": id });
    button.onclick = () => { state.section = id; render(); };
    return button;
  }));
  const ranges = $("nav", { id: "ranges" }, RANGES.map(range => {
    const button = $("button", { text: range, "data-range": range });
    button.onclick = () => { state.range = range; render(); };
    return button;
  }));
  const sync = $("button", { text: "sync" });
  const status = $("span", { id: "status" });
  sync.onclick = async () => {
    sync.disabled = true;
    status.textContent = "syncing...";
    try {
      const result = await fetch("/api/sync", { method: "POST" }).then(r => r.json());
      status.textContent = "indexed " + result.counts.messages + " new messages";
      await render();
    } catch (error) {
      status.textContent = "sync failed: " + error.message;
    } finally {
      sync.disabled = false;
    }
  };

  document.body.prepend($("header", {}, [$("h1", { text: "PI Usage Statistics" }), nav, ranges, sync, status]));
  window.addEventListener("hashchange", () => {
    const [s, r] = location.hash.replace(/^#/, "").split("/");
    if (renderers[s] && (s !== state.section || r !== state.range)) {
      state.section = s;
      if (RANGES.includes(r)) state.range = r;
      render();
    }
  });
  render();
}

boot();
`;

export function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PI Usage Statistics</title>
<style>${STYLE}</style>
</head>
<body>
<main></main>
<script>${SCRIPT}</script>
</body>
</html>`;
}
