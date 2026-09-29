const { Readability } = require("@mozilla/readability");
const TurndownService = require("turndown");
const fetch = require("node-fetch");

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
});

function extractText(html, url) {
  const jsdom = require("jsdom");
  const { JSDOM } = jsdom;
  const doc = new JSDOM(html, { url });
  const reader = new Readability(doc.window.document);
  const article = reader.parse();
  if (!article) return null;
  return {
    title: article.title || new URL(url).hostname,
    excerpt: article.excerpt || "",
    content: article.content,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const url =
    event.queryStringParameters?.url ||
    event.queryStringParameters?.q ||
    null;

  if (!url) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing 'url' query parameter." }),
    };
  }

  let normalizedUrl;
  try {
    normalizedUrl = new URL(url);
    if (!["http:", "https:"].includes(normalizedUrl.protocol)) {
      throw new Error("Only http/https URLs are supported.");
    }
    normalizedUrl = normalizedUrl.href;
  } catch (err) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: `Invalid URL: ${err.message}` }),
    };
  }

  let html;
  try {
    const resp = await fetch(normalizedUrl, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent":
          "page2prompt/0.1 (https://page2prompt.com; LLM content extraction)",
      },
      redirect: "follow",
      timeout: 20000,
    });
    if (!resp.ok) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: `Remote server returned ${resp.status} ${resp.statusText}.`,
        }),
      };
    }
    const contentType = (resp.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("html")) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Remote URL does not serve HTML content.",
        }),
      };
    }
    html = await resp.text();
  } catch (err) {
    const msg =
      err.code === "ETIMEDOUT" || err.message?.includes("timeout")
        ? "Request timed out."
        : err.message || "Failed to fetch URL.";
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: msg }),
    };
  }

  let extracted;
  try {
    extracted = extractText(html, normalizedUrl);
  } catch (err) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: `Extraction failed: ${err.message}`,
      }),
    };
  }

  if (!extracted || !extracted.content) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Could not extract readable content from this page.",
      }),
    };
  }

  const markdown = turndown.turndown(extracted.content);
  const fullDoc = `# ${extracted.title}\n\n${extracted.excerpt ? extracted.excerpt + "\n\n" : ""}${markdown}`;

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: extracted.title,
      sourceUrl: normalizedUrl,
      markdown: fullDoc,
    }),
  };
};
