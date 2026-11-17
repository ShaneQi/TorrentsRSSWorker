/**
 * RSS feed Worker + MCP server (Streamable HTTP, stateless, no dependencies).
 *
 * Routes:
 *   GET  /f/<PATH_SECRET>/movies.xml | shows.xml  -> public, read-only RSS feed
 *   POST /mcp                                     -> MCP endpoint, Cloudflare Access only
 *
 * The Worker verifies the Cf-Access-Jwt-Assertion header on /mcp itself, so a
 * request that skips Access (workers.dev URL, missing Access app) is rejected.
 *
 * Env:
 *   PATH_SECRET         secret path segment for the feeds
 *   TRACKER_DOWNLOAD_TOKEN  tracker passkey (TTG download token)
 *   TRACKER_DOWNLOAD_URL  e.g. "https://totheglory.im/dl/{id}/{passkey}"
 *   ACCESS_TEAM_DOMAIN  e.g. "yourteam.cloudflareaccess.com"
 *   ACCESS_AUD          Application Audience (AUD) tag of the Access app
 *   FEED_MOVIES, FEED_SHOWS  KV bindings
 */

const MAX_ITEMS = 200;
const SERVER_INFO = { name: "rss-feeds", version: "1.0.0" };
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const FEEDS = {
  movies: {
    kv: "FEED_MOVIES",
    title: "Movies",
    link: "https://example.com",
    description: "Private movies feed",
  },
  shows: {
    kv: "FEED_SHOWS",
    title: "Shows",
    link: "https://example.com",
    description: "Private shows feed",
  },
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ---- MCP endpoint (Cloudflare Access only) ----
    if (url.pathname === "/mcp") {
      const denied = await requireAccess(request, env);
      if (denied) return denied;
      if (request.method === "POST") return handleMcp(request, env);
      // Stateless server: no SSE stream, no sessions to delete.
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "POST" },
      });
    }

    // ---- Public read-only RSS feeds ----
    const secret = pathSecret(env);
    if (!secret) {
      return new Response("PATH_SECRET not configured", { status: 500 });
    }
    const prefix = `/f/${secret}/`;
    if (!url.pathname.startsWith(prefix)) {
      return new Response("Not found", { status: 404 });
    }

    const feedMatch = url.pathname.slice(prefix.length).match(/^(movies|shows)\.xml$/);
    if ((request.method === "GET" || request.method === "HEAD") && feedMatch) {
      const cfg = FEEDS[feedMatch[1]];
      const kv = env[cfg.kv];
      if (!kv) return new Response(`${cfg.kv} not bound`, { status: 500 });
      return serveFeed(kv, cfg);
    }

    return new Response("Not found", { status: 404 });
  },
};

/* ------------------------------------------------------------------ */
/* MCP                                                                 */
/* ------------------------------------------------------------------ */

const FEED_PARAM = {
  type: "string",
  enum: Object.keys(FEEDS),
  description: "Which feed: 'movies' or 'shows'",
};

const TOOLS = [
  {
    name: "inspect_torrent",
    description:
      "Look up a torrent on the private tracker by its numeric id: returns the torrent's name, total size and file list. " +
      "Call this first whenever the user gives a tracker torrent id (or a tracker URL — extract the id), then decide " +
      "whether it is a movie or a TV show (season packs, single episodes, miniseries, anime series and variety shows are 'shows'; " +
      "films, including multi-part movie collections and Blu-ray disc folders, are 'movies'), then call add_torrent.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Tracker torrent id, e.g. '12345'" } },
      required: ["id"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "add_torrent",
    description:
      "Add a tracker torrent to the movies or shows feed by its numeric id. The server builds the passkey download link itself. " +
      "Call inspect_torrent first and choose the feed from what it returns. If the name is genuinely ambiguous, ask the user.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Tracker torrent id, e.g. '12345'" },
        feed: FEED_PARAM,
        title: { type: "string", description: "Optional: override the title (defaults to the torrent's name)" },
      },
      required: ["id", "feed"],
    },
  },
  {
    name: "add_item",
    description:
      "Add an item to the movies or shows RSS feed. Provide a title and/or an enclosure URL (torrent or magnet link).",
    inputSchema: {
      type: "object",
      properties: {
        feed: FEED_PARAM,
        title: { type: "string", description: "Item title" },
        enclosure: { type: "string", description: "Enclosure URL (.torrent or magnet link)" },
      },
      required: ["feed"],
    },
  },
  {
    name: "list_items",
    description: "List the most recent items in a feed, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        feed: FEED_PARAM,
        limit: { type: "integer", minimum: 1, maximum: MAX_ITEMS, default: 20 },
      },
      required: ["feed"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "delete_item",
    description: "Delete an item from a feed by its id (as returned by list_items or add_item).",
    inputSchema: {
      type: "object",
      properties: {
        feed: FEED_PARAM,
        id: { type: "string", description: "Item id, e.g. item:2026-11-17T...:uuid" },
      },
      required: ["feed", "id"],
    },
    annotations: { destructiveHint: true },
  },
];

async function handleMcp(request, env) {
  let msg;
  try {
    msg = await request.json();
  } catch {
    return rpcResponse(rpcError(null, -32700, "Parse error"), 400);
  }

  // Batches (allowed in 2025-03-26) — handle each and return an array.
  if (Array.isArray(msg)) {
    const results = (await Promise.all(msg.map((m) => dispatch(m, env)))).filter(Boolean);
    return results.length ? rpcResponse(results) : new Response(null, { status: 202 });
  }

  const result = await dispatch(msg, env);
  // Notifications / responses get 202 with no body.
  return result ? rpcResponse(result) : new Response(null, { status: 202 });
}

async function dispatch(msg, env) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    // A client response or garbage — nothing to reply to.
    return msg && "id" in msg && !("result" in msg || "error" in msg)
      ? rpcError(msg.id ?? null, -32600, "Invalid Request")
      : null;
  }

  const isNotification = !("id" in msg);
  if (isNotification) return null; // e.g. notifications/initialized

  const { id, method, params = {} } = msg;

  try {
    switch (method) {
      case "initialize": {
        const requested = params.protocolVersion;
        return rpcResult(id, {
          protocolVersion: SUPPORTED_PROTOCOLS.includes(requested)
            ? requested
            : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions:
            "Manage two private RSS feeds (movies, shows). Given a tracker torrent id: call inspect_torrent, decide movie vs show from the name and files, then call add_torrent with that feed. Use add_item only for an arbitrary URL, list_items to see what's there, delete_item to remove one.",
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: TOOLS });
      case "tools/call":
        return rpcResult(id, await callTool(params.name, params.arguments || {}, env));
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return rpcError(id, -32603, String(err?.message || err));
  }
}

async function callTool(name, args, env) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return toolError(`Unknown tool: ${name}`);

  if (name === "inspect_torrent") return inspectTorrent(args, env);
  if (name === "add_torrent") return addTorrent(args, env);

  const cfg = FEEDS[args.feed];
  if (!cfg) return toolError(`feed must be one of: ${Object.keys(FEEDS).join(", ")}`);
  const kv = env[cfg.kv];
  if (!kv) return toolError(`${cfg.kv} not bound`);

  switch (name) {
    case "add_item": {
      const res = await putItem(kv, args.title, args.enclosure);
      if (res.error) return toolError(res.error);
      const shown = { ...res, enclosure: redact(res.enclosure, env) };
      return toolText(`Added to ${args.feed}: ${res.title}\nid: ${res.id}`, shown);
    }
    case "list_items": {
      const limit = Math.min(Math.max(parseInt(args.limit ?? 20, 10) || 20, 1), MAX_ITEMS);
      // Never send the passkey back to the chat.
      const items = (await loadItems(kv))
        .slice(0, limit)
        .map((it) => ({ ...it, enclosure: redact(it.enclosure, env) }));
      if (!items.length) return toolText(`${args.feed} feed is empty.`, { items: [] });
      const lines = items.map(
        (it, i) => `${i + 1}. ${it.title}\n   created: ${it.created}\n   id: ${it.id}\n   enclosure: ${it.enclosure || "(none)"}`,
      );
      return toolText(lines.join("\n"), { items });
    }
    case "delete_item": {
      const id = String(args.id || "");
      if (!id.startsWith("item:")) return toolError("id must start with 'item:'");
      if ((await kv.get(id)) === null) return toolError(`No item with id ${id} in ${args.feed}`);
      await kv.delete(id);
      return toolText(`Deleted ${id} from ${args.feed}.`, { deleted: id });
    }
  }
}

/* ------------------------------------------------------------------ */
/* add_torrent: tracker id -> passkey link -> .torrent name -> feed    */
/* ------------------------------------------------------------------ */

/** Build the passkey link for a tracker id, download the .torrent and parse it. */
async function fetchTorrent(rawId, env) {
  const id = String(rawId ?? "").trim();
  if (!/^\d+$/.test(id)) return { error: "id must be the numeric tracker torrent id" };

  const template = env.TRACKER_DOWNLOAD_URL; // e.g. https://site/download.php?id={id}&passkey={passkey}
  const passkey = trackerToken(env);
  if (!template || !passkey || !template.includes("{id}")) {
    return { error: "TRACKER_DOWNLOAD_URL (with {id} and {passkey}) and TRACKER_DOWNLOAD_TOKEN must be set" };
  }
  const link = template.replaceAll("{id}", id).replaceAll("{passkey}", encodeURIComponent(passkey));

  let res;
  try {
    res = await fetch(link, { headers: { "User-Agent": "Mozilla/5.0 (rss-feeds worker)" } });
  } catch (err) {
    return { error: `Couldn't reach the tracker: ${err.message}` };
  }
  if (!res.ok) return { error: `Tracker returned HTTP ${res.status} for torrent ${id}` };

  const bytes = new Uint8Array(await res.arrayBuffer());
  try {
    return { id, link, info: readTorrentInfo(bytes) };
  } catch {
    // Usually an HTML error/login page: wrong id, bad passkey, or rate limit.
    const peek = new TextDecoder().decode(bytes.slice(0, 200)).replace(/\s+/g, " ");
    return { error: `Response for torrent ${id} isn't a .torrent file. Start of response: ${redact(peek, env)}` };
  }
}

const MAX_LISTED_FILES = 40;

async function inspectTorrent(args, env) {
  const t = await fetchTorrent(args.id, env);
  if (t.error) return toolError(t.error);
  const { name, files } = t.info;

  const total = files.reduce((sum, f) => sum + f.length, 0);
  const sorted = [...files].sort((a, b) => b.length - a.length);
  const shown = sorted.slice(0, MAX_LISTED_FILES);
  const lines = shown.map((f) => `  ${fmtSize(f.length).padStart(9)}  ${f.path}`);
  if (sorted.length > shown.length) lines.push(`  … and ${sorted.length - shown.length} smaller files`);

  return toolText(
    `torrent ${t.id}\nname: ${name}\ntotal: ${fmtSize(total)} in ${files.length} file(s), largest first:\n${lines.join("\n")}`,
    { id: t.id, name, totalBytes: total, fileCount: files.length, files: shown },
  );
}

async function addTorrent(args, env) {
  const cfg = FEEDS[args.feed];
  if (!cfg) return toolError(`feed must be one of: ${Object.keys(FEEDS).join(", ")}`);
  const kv = env[cfg.kv];
  if (!kv) return toolError(`${cfg.kv} not bound`);

  // Re-fetch so a bad id or passkey never ends up in the feed.
  const t = await fetchTorrent(args.id, env);
  if (t.error) return toolError(t.error);

  const title = String(args.title || "").trim() || t.info.name;
  const saved = await putItem(kv, title, t.link);
  if (saved.error) return toolError(saved.error);

  return toolText(`Added to ${args.feed}: ${title}\nid: ${saved.id}`, {
    id: saved.id,
    feed: args.feed,
    title,
  });
}

function fmtSize(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

/** Parse a .torrent and return { name, files: [{path, length}] }. */
function readTorrentInfo(bytes) {
  const torrent = bdecode(bytes);
  const info = torrent?.info;
  if (!info || typeof info !== "object" || info instanceof Uint8Array) throw new Error("no info dict");

  const td = new TextDecoder();
  const str = (v) => (v instanceof Uint8Array ? td.decode(v) : "");
  const name = str(info["name.utf-8"]) || str(info.name);
  if (!name) throw new Error("no name");

  let files;
  if (Array.isArray(info.files)) {
    files = info.files.map((f) => {
      const parts = f["path.utf-8"] || f.path || [];
      return { path: parts.map(str).join("/"), length: Number(f.length) || 0 };
    });
  } else {
    files = [{ path: name, length: Number(info.length) || 0 }];
  }
  return { name, files };
}

/** Minimal bencode decoder. Strings stay as Uint8Array; integers become numbers. */
function bdecode(bytes) {
  let i = 0;
  const td = new TextDecoder();

  function readUntil(ch) {
    const start = i;
    while (i < bytes.length && bytes[i] !== ch) i++;
    if (i >= bytes.length) throw new Error("unexpected end");
    const s = td.decode(bytes.subarray(start, i));
    i++; // skip terminator
    return s;
  }

  function next() {
    if (i >= bytes.length) throw new Error("unexpected end");
    const c = bytes[i];
    if (c === 0x69) { // i<int>e
      i++;
      const n = Number(readUntil(0x65));
      if (!Number.isFinite(n)) throw new Error("bad int");
      return n;
    }
    if (c === 0x6c) { // l...e
      i++;
      const list = [];
      while (bytes[i] !== 0x65) list.push(next());
      i++;
      return list;
    }
    if (c === 0x64) { // d...e
      i++;
      const dict = {};
      while (bytes[i] !== 0x65) {
        const key = td.decode(next());
        dict[key] = next();
      }
      i++;
      return dict;
    }
    if (c >= 0x30 && c <= 0x39) { // <len>:<bytes>
      const len = Number(readUntil(0x3a));
      if (!Number.isInteger(len) || len < 0 || i + len > bytes.length) throw new Error("bad string");
      const s = bytes.subarray(i, i + len);
      i += len;
      return s;
    }
    throw new Error("bad bencode");
  }

  if (bytes[0] !== 0x64) throw new Error("not a bencoded dict");
  return next();
}

/** Secrets with stray whitespace/newlines removed (common when piped into `wrangler secret put`). */
function pathSecret(env) {
  return String(env.PATH_SECRET ?? "").trim();
}
function trackerToken(env) {
  return String(env.TRACKER_DOWNLOAD_TOKEN ?? "").trim();
}

/** Hide the passkey and feed secret in anything sent back to the chat. */
function redact(text, env) {
  let s = String(text ?? "");
  for (const secret of [trackerToken(env), pathSecret(env)]) {
    if (secret) s = s.replaceAll(secret, "***").replaceAll(encodeURIComponent(secret), "***");
  }
  return s.replace(/(passkey|torrent_pass|authkey)=([^&\s"]+)/gi, "$1=***");
}

function toolText(text, structured) {
  const out = { content: [{ type: "text", text }] };
  if (structured) out.structuredContent = structured;
  return out;
}
function toolError(text) {
  return { content: [{ type: "text", text }], isError: true };
}
function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
function rpcResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/* ------------------------------------------------------------------ */
/* Feed storage                                                        */
/* ------------------------------------------------------------------ */

async function putItem(kv, rawTitle, rawEnclosure) {
  const title = String(rawTitle || "").trim();
  const enclosure = String(rawEnclosure || "").trim();
  if (!title && !enclosure) return { error: "title or enclosure required" };

  const created = new Date().toISOString();
  const id = `item:${created}:${crypto.randomUUID()}`;
  const record = { title: title || "untitled", enclosure, created };
  await kv.put(id, JSON.stringify(record));
  return { id, ...record };
}

async function loadItems(kv) {
  const items = [];
  let cursor;

  do {
    const page = await kv.list({ prefix: "item:", cursor });
    for (const key of page.keys) {
      const raw = await kv.get(key.name);
      if (!raw) continue;
      try {
        const data = JSON.parse(raw);
        items.push({
          id: key.name,
          title: data.title || "untitled",
          enclosure: data.enclosure || "",
          created: data.created || key.name.slice(5),
        });
      } catch {
        // skip bad values
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  items.sort((a, b) => String(b.created).localeCompare(String(a.created)));
  return items.slice(0, MAX_ITEMS);
}

/* ------------------------------------------------------------------ */
/* Cloudflare Access JWT verification                                  */
/* ------------------------------------------------------------------ */

let jwksCache = { keys: null, fetchedAt: 0 };
const JWKS_TTL_MS = 60 * 60 * 1000;

/** Returns null if the request carries a valid Access JWT, else an error Response. */
async function requireAccess(request, env) {
  const team = String(env.ACCESS_TEAM_DOMAIN || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  const aud = env.ACCESS_AUD;
  if (!team || !aud) {
    // Fail closed: never expose /mcp without Access configured.
    return new Response("Access not configured", { status: 500 });
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return accessDenied("missing Access token");

  try {
    const [h, p, s] = token.split(".");
    if (!h || !p || !s) return accessDenied("malformed token");

    const header = JSON.parse(b64urlToString(h));
    const payload = JSON.parse(b64urlToString(p));
    if (header.alg !== "RS256") return accessDenied("unexpected alg");

    let jwk = await findJwk(team, header.kid, false);
    if (!jwk) jwk = await findJwk(team, header.kid, true); // key rotation
    if (!jwk) return accessDenied("unknown signing key");

    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlToBytes(s),
      new TextEncoder().encode(`${h}.${p}`),
    );
    if (!valid) return accessDenied("bad signature");

    const now = Math.floor(Date.now() / 1000);
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(aud)) return accessDenied("wrong audience");
    if (payload.iss !== `https://${team}`) return accessDenied("wrong issuer");
    if (typeof payload.exp !== "number" || payload.exp < now - 60) return accessDenied("expired");
    if (typeof payload.nbf === "number" && payload.nbf > now + 60) return accessDenied("not yet valid");

    return null;
  } catch {
    return accessDenied("invalid token");
  }
}

async function findJwk(team, kid, forceRefresh) {
  const stale = Date.now() - jwksCache.fetchedAt > JWKS_TTL_MS;
  if (!jwksCache.keys || stale || forceRefresh) {
    const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
    const data = await res.json();
    jwksCache = { keys: data.keys || [], fetchedAt: Date.now() };
  }
  return jwksCache.keys.find((k) => k.kid === kid);
}

function accessDenied(reason) {
  return new Response(JSON.stringify({ error: "forbidden", reason }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function b64urlToString(s) {
  return new TextDecoder().decode(b64urlToBytes(s));
}

/* ------------------------------------------------------------------ */
/* RSS                                                                 */
/* ------------------------------------------------------------------ */

async function serveFeed(kv, cfg) {
  const items = await loadItems(kv);
  const now = new Date().toUTCString();

  const body = [];
  for (const item of items) {
    const guid = await sha256Hex32(item.id + "|" + item.title);
    const pubDate = new Date(item.created || Date.now()).toUTCString();

    body.push(`    <item>
        <title><![CDATA[${cdata(item.title)}]]></title>
        <enclosure url="${esc(item.enclosure)}" length="0" type="application/x-bittorrent" />
        <guid isPermaLink="false">${esc(guid)}</guid>
        <pubDate>${pubDate}</pubDate>
    </item>`);
  }

  const xml = `<?xml version="1.0" encoding="utf-8"?><rss version="2.0">
	<channel>
		<title>${esc(cfg.title)}</title>
		<link><![CDATA[${cdata(cfg.link)}]]></link>
		<description><![CDATA[${cdata(cfg.description)}]]></description>
		<language>zh-cn</language>
		<pubDate>${now}</pubDate>
		<generator>RSS Generator</generator>
		<docs><![CDATA[http://www.rssboard.org/rss-specification]]></docs>
		<ttl>5</ttl>

${body.join("")}</channel></rss>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function sha256Hex32(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

function cdata(s) {
  return String(s).replaceAll("]]>", "]]]]><![CDATA[>");
}

function esc(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
