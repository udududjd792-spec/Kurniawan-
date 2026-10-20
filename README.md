# Hentai Hub for Stremio — v2.5.1

Node.js Stremio addon with four providers: HentaiGasm, HentaiSmile, HentaiCity, and HentaiMama. Hanime and Hentai.TV are removed from the manifest because their catalogs were returning no items.

## Fixes in v2.5.1

- HentaiGasm uses its previous catalog path, parser path, stream resolver, headers, and default stream-cache duration.
- HentaiSmile and HentaiCity discover actual pagination links from the fetched page before trying fallback routes; provider-specific parsers remove duration/view text from titles and recover lazy-loaded posters.
- HentaiCity `/click/.../video/...` links are normalized to `/video/...`, and page-numbered `.html` routes are generated.
- HentaiMama uses provider-specific genre routes, keeps recent-episode cards separate from series cards, deduplicates repeated episode/series links, and avoids turning an individual episode page into a playlist of sidebar/recommended episodes.
- HentaiMama stream resolution uses the page's `var data` payload, submits it to `admin-ajax.php`, opens the returned player iframe, and attempts to extract the native media URL. If a host blocks server-side extraction, a browser fallback can still be returned.
- Non-HentaiGasm embed searches follow up to five levels by default to handle deeper player nesting.

## Deploy

1. Replace `index.js` and `package.json` in the repository with these versions.
2. Push the changes and let the hosting service reinstall dependencies and redeploy.
3. Install the public HTTPS URL ending in `/manifest.json` in Stremio. The `127.0.0.1` URL printed in logs is internal to the server.
4. Check deploy logs for `[HentaiSmile]`, `[HentaiCity]`, and `[HentaiMama]` catalog/parser messages and `stream resolver` direct-versus-browser counts.

## Tests

Run after dependencies install:

```sh
npm test
npm start
```

The regression suite covers provider removal/preservation, provider-specific pagination, canonical URLs, titles, catalog parsing/deduplication, and HentaiMama's AJAX iframe extraction.

## Environment variables

`PORT`, `USER_AGENT`, `HTTP_TIMEOUT_MS`, `CACHE_CATALOG_SECONDS`, `CACHE_DETAIL_SECONDS`, `CACHE_STREAM_SECONDS`, `EMBED_DEPTH`, `EMBED_PAGE_LIMIT`, `HENTAIMAMA_BASE`, `HENTAIGASM_BASE`, `HENTAISMILE_BASE`, and `HENTAICITY_BASE`.
