/** Describes Firecrawl search and its model-context output limits. */
export const SEARCH_TOOL_DESCRIPTION =
  "Search the web with Firecrawl. Returns web, news, or image results. Output is limited to 50KB or 2000 lines; complete truncated output is saved to a temporary file.";

/** Adds Firecrawl's current-information search capability to the model's tool prompt. */
export const SEARCH_PROMPT_SNIPPET =
  "Search the web with Firecrawl for current information.";

/** Guides the model on when to search and when to follow with scrape or crawl. */
export const SEARCH_PROMPT_GUIDELINES = [
  "Use search when the user asks for current web information, discovery, or sources beyond the local workspace.",
  "Use scrape after search when you need the full readable content of a specific page.",
  "Use crawl when the user needs content from multiple pages of the same website.",
];

/** Model-facing schema descriptions for Firecrawl search parameters. */
export const SEARCH_PARAMETER_DESCRIPTIONS = {
  query: "The web search query.",
  limit: "Maximum number of results. Defaults to 5.",
  scrapeResults:
    "Whether to include markdown scraped from each result. Defaults to false.",
};

/** Describes multi-page Firecrawl crawling and its page and output limits. */
export const CRAWL_TOOL_DESCRIPTION =
  "Crawl multiple pages of a website with Firecrawl and return markdown documents. Defaults to 20 pages and never accepts a limit above 100. Output is limited to 50KB or 2000 lines; complete truncated output is saved to a temporary file.";

/** Adds Firecrawl's multi-page crawl capability to the model's tool prompt. */
export const CRAWL_PROMPT_SNIPPET =
  "Crawl multiple pages of a website with Firecrawl.";

/** Guides the model to use focused crawl limits and prefer scrape for one URL. */
export const CRAWL_PROMPT_GUIDELINES = [
  "Use crawl when the user needs content from multiple related pages on one website.",
  "Keep crawl limits as low as practical because each crawled page consumes Firecrawl credits.",
  "Use scrape instead of crawl when only one known URL is needed.",
];

/** Model-facing schema descriptions for Firecrawl crawl parameters. */
export const CRAWL_PARAMETER_DESCRIPTIONS = {
  url: "The starting URL to crawl.",
  limit: "Maximum pages to crawl. Defaults to 20; maximum 100.",
  maxDiscoveryDepth: "Maximum link-discovery depth from the starting URL.",
  includePaths: "URL pathname regex patterns to include.",
  excludePaths: "URL pathname regex patterns to exclude.",
  crawlEntireDomain: "Allow sibling and parent paths on the same domain.",
  allowSubdomains: "Allow crawling subdomains.",
  onlyMainContent: "Extract only each page's main content. Defaults to true.",
  timeout: "Maximum crawl wait time in seconds. Defaults to 120.",
};

/** Describes single-page Firecrawl scraping and its model-context output limits. */
export const SCRAPE_TOOL_DESCRIPTION =
  "Scrape one page with Firecrawl and return markdown. Output is limited to 50KB or 2000 lines; complete truncated output is saved to a temporary file.";

/** Adds Firecrawl's readable single-page fetch capability to the model's tool prompt. */
export const SCRAPE_PROMPT_SNIPPET =
  "Fetch one URL as readable markdown with Firecrawl.";

/** Guides the model to use scrape for one known page and crawl for multiple pages. */
export const SCRAPE_PROMPT_GUIDELINES = [
  "Use scrape when you need the full readable markdown content of one known URL.",
  "Prefer scrape over bash or raw HTTP fetching for web pages because scrape returns cleaned content.",
  "Use crawl instead when content is needed from multiple pages on the same website.",
];

/** Model-facing schema descriptions for Firecrawl scrape parameters. */
export const SCRAPE_PARAMETER_DESCRIPTIONS = {
  url: "The URL to scrape.",
  onlyMainContent: "Return only the main page content. Defaults to true.",
  waitFor:
    "Milliseconds to wait before capture, useful for JavaScript-heavy pages.",
  timeout: "Request timeout in milliseconds. Defaults to 30000.",
  includeMetadata:
    "Append page metadata to the markdown. Defaults to false; metadata remains available in tool details.",
};

/** Describes structured extraction from one or more pages. */
export const EXTRACT_TOOL_DESCRIPTION =
  "Extract structured JSON from one or more web pages. Give a natural-language prompt describing the fields you want, and optionally a JSON Schema the result must match. Use this instead of scrape when you need specific fields (prices, names, dates, links) rather than the page text - it returns parsed data, not markdown, so it costs far less context.";

/** Adds structured web extraction to the parent model's available-tools prompt. */
export const EXTRACT_PROMPT_SNIPPET =
  "Extract structured JSON fields from one or more web pages";

/** Guides the model toward extraction over scrape-and-parse. */
export const EXTRACT_PROMPT_GUIDELINES = [
  "Prefer extract over scrape when you want specific fields; scrape returns the whole page and wastes context.",
  "Pass a JSON Schema whenever the shape matters - it makes the result stable enough to act on.",
  "Extraction runs per URL; batch related pages into one call rather than looping.",
];

/** Model-facing schema descriptions for extract. */
export const EXTRACT_PARAMETER_DESCRIPTIONS = {
  urls: "Page URLs to extract from (1-10). Each is fetched and extracted independently.",
  prompt:
    "What to extract, in plain language. Be specific about the fields and their meaning.",
  schema:
    "Optional JSON Schema object the extracted data must conform to. Strongly recommended when the shape matters.",
  onlyMainContent:
    "Extract from the main content only, skipping navigation and footers (default true)",
  timeout: "Per-URL timeout in milliseconds (default 60000)",
};
