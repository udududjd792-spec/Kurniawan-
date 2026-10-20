# Hentai Hub for Stremio — v2.4.1

Node.js Stremio addon with provider-specific catalog routes, tolerant poster parsing, recursive player/embed resolution, an alternate Hanime landing API attempt, and a browser-page fallback when direct stream extraction fails.

## Deploy

1. Replace the repository `index.js` and `package.json` with the files in this package. Keep `render.yaml` if using the included Render configuration.
2. Push the changes so the deployment host rebuilds dependencies and starts the app.
3. Open the deployment's public HTTPS `/manifest.json` URL and install that URL in Stremio. The `127.0.0.1` address printed in process logs is internal and is not the public install URL.
4. Inspect logs for `[Provider] catalog failed`, `parser found 0 eligible cards`, Hanime fallback messages, and `stream resolver` counts.

## Tests

After dependency installation, run:

```sh
npm test
npm start
```

Tests cover canonical www/non-www host matching, catalog pagination URLs, HTML and JSON-LD card parsing, Hanime landing-response normalization, direct media URL extraction, and escaped iframe extraction.

## Environment variables

`PORT`, `USER_AGENT`, `HTTP_TIMEOUT_MS`, `CACHE_CATALOG_SECONDS`, `CACHE_DETAIL_SECONDS`, `CACHE_STREAM_SECONDS`, `EMBED_DEPTH`, `EMBED_PAGE_LIMIT`, `HENTAIMAMA_BASE`, `HENTAITV_BASE`, `HENTAIGASM_BASE`, `HENTAISMILE_BASE`, `HENTAICITY_BASE`, `HANIME_SEARCH_URL`, `HANIME_API`, and `HANIME_LANDING_URL`.

The add-on can provide direct media streams only when a provider exposes extractable media URLs. If a player blocks server-side extraction or renders the video client-side, it returns a browser link to the source page instead of an empty stream list. If a provider blocks the deployment itself, code cannot guarantee direct playback from that provider.
