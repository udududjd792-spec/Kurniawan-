# Hentai Hub for Stremio — v2.5.2

Node.js Stremio addon with four providers: HentaiGasm, HentaiSmile, HentaiCity, and HentaiMama. Hanime and Hentai.TV are omitted because their catalogs were returning no items.

## Changes in v2.5.2

- Fixes HentaiGasm's empty catalog: v2.5.1 called `fetchCatalogLegacy()`, which was not defined.
- Corrects Stremio pagination. `skip` is applied to collected catalog items rather than being mistaken for an upstream page number. This avoids dropping cards on providers that return more than 20 items per page and fixes pagination in the combined catalog.
- HentaiCity uses the site's numbered `.html` paths for catalog pages and category pages; `/click/.../video/...` links are normalized to `/video/...`.
- HentaiSmile rejects placeholder titles such as `No title found` and falls back to the video slug. Its pagination parser prefers actual pagination links when present.
- HentaiMama's 3D archive uses `/genre/3d/`; its uncensored archive uses `/uncensored/`. HentaiMama resolution tries direct player sources and the WordPress AJAX mirror list, then checks returned iframe players for media URLs.
- HentaiMama, HentaiSmile, and HentaiCity now return only streams with a direct media URL. They no longer offer the source page itself as a fake stream that opens an external website. HentaiGasm's legacy fallback is preserved.
- Hanime and Hentai.TV remain removed.

## Deploy

1. Replace `index.js`, `package.json`, `test.js`, and `README.md` in the repository with the matching files in the ZIP.
2. Push the changes and let the hosting service reinstall dependencies and redeploy.
3. Install the deployment's public HTTPS URL ending in `/manifest.json` in Stremio. The `127.0.0.1` URL in the server log is internal to the server.
4. Check deploy logs for the provider name and the `stream resolver` counts if a catalog or stream still fails.

## Tests

Run after dependencies install:

```sh
npm test
npm start
```

The suite includes provider-manifest checks, route and URL normalization tests, parser fixtures, HentaiMama AJAX/player extraction, and a regression test for paginating source pages with unequal item counts.

The local checks for this build passed JavaScript syntax checks, JSON/package checks, eight dependency-independent tests, and a mocked HentaiMama AJAX-to-media resolution. Real playback still needs confirmation on the deployed host because the local runtime could not reach provider endpoints.

## Environment variables

`PORT`, `USER_AGENT`, `HTTP_TIMEOUT_MS`, `CACHE_CATALOG_SECONDS`, `CACHE_DETAIL_SECONDS`, `CACHE_STREAM_SECONDS`, `EMBED_DEPTH`, `EMBED_PAGE_LIMIT`, `HENTAIMAMA_BASE`, `HENTAIGASM_BASE`, `HENTAISMILE_BASE`, and `HENTAICITY_BASE`.
