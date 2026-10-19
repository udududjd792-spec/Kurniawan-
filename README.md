# Hentai Hub for Stremio

Multi-provider adult-anime catalog. It uses Stremio's `other` content type so the addon does not declare its items as `movie` or `series`.

## Included providers

- HentaiMama
- Hentai.TV
- Hanime
- Hentaigasm
- HentaiSmile
- HentaiCity

Each provider has its own catalog, plus a combined catalog. Search and genre filters are exposed in the catalog manifest. Provider sites can change markup/domains, so any HTML scraper can need maintenance over time.

## Run locally

Requires Node.js 18+.

```sh
npm install
npm start
```

Then install this URL in Stremio:

```text
http://127.0.0.1:7000/manifest.json
```

For remote/public use, deploy to a Node host with HTTPS and set `PORT` if required. Do not use `localhost` as the URL from another device.

## Optional environment variables

- `PORT` (default `7000`)
- `HENTAIMAMA_BASE`
- `HENTAITV_BASE`
- `HANIME_SEARCH_URL`
- `HANIME_API`
- `HENTAIGASM_BASE`
- `HENTAISMILE_BASE`
- `HENTAICITY_BASE`
- `HTTP_TIMEOUT_MS` (default `15000`)
- `CACHE_CATALOG_SECONDS` (default `600`)
- `CACHE_DETAIL_SECONDS` (default `1800`)
- `CACHE_STREAM_SECONDS` (default `180`)

The addon does not host video files; it reads provider pages and returns available direct streams or external embed links. Third-party site availability and HTML structure determine whether each provider works at a given time.
