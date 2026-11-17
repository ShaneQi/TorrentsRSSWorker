# TorrentsRSSWorker

A Cloudflare Worker that serves two private torrent RSS feeds (movies, shows) for the Synology Download Center, plus an MCP server so Claude can manage them and add torrents from TTG by id.

Everything is in `worker.js`, with no dependencies.

## Routes

| Route | Who | What |
|---|---|---|
| `GET /f/<PATH_SECRET>/movies.xml`, `GET /f/<PATH_SECRET>/shows.xml` | Public (secret path) | RSS feeds, newest 200 items |
| `POST /mcp` | Cloudflare Access only | MCP server (stateless Streamable HTTP) |

## MCP tools

- `inspect_torrent(id)`: downloads the `.torrent` from the tracker and returns its name, size and files, so Claude can decide movie or show.
- `add_torrent(id, feed, title?)`: adds the tracker download link to `movies` or `shows`.
- `add_item(feed, title?, enclosure?)`: adds any link.
- `list_items(feed, limit?)`, `delete_item(feed, id)`.

The tracker token and the feed secret are shown as `***` in every tool response.

## Configuration

| Name | Kind | Value |
|---|---|---|
| `FEED_MOVIES`, `FEED_SHOWS` | KV bindings | One namespace per feed |
| `PATH_SECRET` | Secret | Secret path segment for the feeds |
| `TRACKER_DOWNLOAD_TOKEN` | Secret | Tracker passkey (TTG download token) |
| `TRACKER_DOWNLOAD_URL` | Variable | `https://totheglory.im/dl/{id}/{passkey}` |
| `ACCESS_TEAM_DOMAIN` | Variable | `<team>.cloudflareaccess.com` |
| `ACCESS_AUD` | Variable | AUD tag of the Access application that protects `/mcp` |

## Cloudflare Access

`/mcp` must sit behind Cloudflare Access, and the Worker also verifies the `Cf-Access-Jwt-Assertion` token itself (signature, audience, issuer, expiry). It returns 403 without a valid token, and 500 if the Access variables aren't set.

The feeds must stay public, because the Download Center can't sign in. Add a second Access application for the `/f` path with a Bypass policy for everyone.

## Deployment

`.github/workflows/deploy.yml` deploys the `torrents` Worker with Wrangler on every push to `main`, and on demand from the Actions tab.

GitHub repository settings needed:

| Name | Kind | Value |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Secret | API token with the *Edit Cloudflare Workers* template permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Secret | Cloudflare account ID |
| `KV_MOVIES_ID` | Variable | KV namespace ID bound as `FEED_MOVIES` |
| `KV_SHOWS_ID` | Variable | KV namespace ID bound as `FEED_SHOWS` |

Variables, secrets and routes stay in the Cloudflare dashboard: `wrangler.toml` sets `keep_vars = true` and declares no routes, so a deploy only changes the code and KV bindings.
