'use strict';

// Hentai Hub for Stremio
// Content type is "other" (not movie/series and not an unsupported custom type).
// Run: npm install && npm start

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

const PORT = Number(process.env.PORT) || 7000;
const CONTENT_TYPE = 'other';
const UA = process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const CATALOG_TTL = Number(process.env.CACHE_CATALOG_SECONDS || 600) * 1000;
const DETAIL_TTL = Number(process.env.CACHE_DETAIL_SECONDS || 1800) * 1000;
const STREAM_TTL = Number(process.env.CACHE_STREAM_SECONDS || 180) * 1000;
const SOURCE_PAGE_SIZE = 20;
const ITEMS_PER_REQUEST = 100;

// Broad, common tags; individual providers may support only a subset.
const GENRES = [
  '3D', 'Ahegao', 'Anal', 'BDSM', 'Big Breasts', 'Blowjob', 'Bondage', 'Boobjob',
  'Cheating', 'Comedy', 'Cosplay', 'Creampie', 'Dark Skin', 'Demon', 'Doujin',
  'Exclusive', 'Exhibition', 'Fantasy', 'Femdom', 'Fetish', 'Footjob', 'Futanari',
  'Gangbang', 'Glasses', 'Group', 'Harem', 'Horror', 'Incest', 'Maid', 'Masturbation',
  'Milf', 'Monster', 'Motion Anime', 'Netorare', 'Nurse', 'Office Lady', 'Preview',
  'Romance', 'School', 'Sci-Fi', 'Season', 'Series', 'Succubus', 'Swimsuit',
  'Tentacle', 'Threesome', 'Uncensored', 'Vanilla', 'Virgin', 'X-Ray', 'Yuri'
];

// Exclude explicitly minor-coded sexual tags/titles from returned catalogue results.
const DISALLOWED_MINOR_TERMS = /\b(loli(?:con)?|shota(?:con)?|underage|child porn|young girl|young boy)\b/i;

const http = axios.create({
  timeout: Number(process.env.HTTP_TIMEOUT_MS || 15000),
  maxRedirects: 5,
  headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  validateStatus: (status) => status >= 200 && status < 400,
});

const cache = new Map();
async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await fn();
  cache.set(key, { value, expires: Date.now() + ttl });
  if (cache.size > 1500) {
    for (const [k, v] of cache) if (v.expires <= Date.now()) cache.delete(k);
    while (cache.size > 1500) cache.delete(cache.keys().next().value);
  }
  return value;
}

const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const stripHtml = (value) => clean(String(value || '').replace(/<[^>]*>/g, ' '));
const slugify = (value) => clean(value).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const encodeKey = (value) => Buffer.from(String(value), 'utf8').toString('base64url');
const decodeKey = (value) => Buffer.from(String(value), 'base64url').toString('utf8');
function absoluteUrl(value, base) {
  try {
    if (!value) return '';
    const url = new URL(String(value).replace(/&amp;/g, '&'), base);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.href;
  } catch { return ''; }
}
function textFromMeta($, selectors) {
  for (const selector of selectors) {
    const node = $(selector).first();
    const value = clean(node.attr('content') || node.text());
    if (value) return value;
  }
  return '';
}
function isImageOrNoiseUrl(url) {
  return /\.(?:jpe?g|png|gif|webp|svg|css|js|ico|woff2?)(?:[?#]|$)|wp-json|wp-content|gravatar|schema\.org/i.test(url || '');
}
function hasMinorCodedContent(item) {
  const text = [item.name, item.description, ...(item.genres || [])].join(' ');
  return DISALLOWED_MINOR_TERMS.test(text);
}

async function getHtml(url, headers = {}) {
  return cached(`html:${url}`, CATALOG_TTL, async () => {
    const response = await http.get(url, { headers, responseType: 'text' });
    return String(response.data || '');
  });
}

function imageFromCard($, $card, $anchor, base) {
  const $img = $card.find('img').first().length ? $card.find('img').first() : $anchor.find('img').first();
  let src = '';
  if ($img.length) {
    src = $img.attr('data-src') || $img.attr('data-lazy-src') || $img.attr('data-original') ||
      $img.attr('data-thumb') || $img.attr('src') || '';
  }
  if (!src) {
    const style = $card.attr('style') || $anchor.attr('style') || '';
    const match = style.match(/background-image\s*:\s*url\(["']?([^"')]+)["']?\)/i);
    if (match) src = match[1];
  }
  return absoluteUrl(src, base);
}

function findCards(html, base) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  const selectors = [
    'article a[href]', '.video-item a[href]', '.video a[href]', '.item a[href]',
    '.thumb a[href]', '.post a[href]', '.result-item a[href]', '.animposx a[href]',
    '.bs a[href]', '.entry a[href]', '.grid-item a[href]', '.movie a[href]',
    'li a[href]', 'a[href]'
  ];

  for (const selector of selectors) {
    $(selector).each((_, element) => {
      const $a = $(element);
      const href = absoluteUrl($a.attr('href'), base);
      if (!href || seen.has(href) || isImageOrNoiseUrl(href)) return;
      if (new URL(href).hostname !== new URL(base).hostname) return;
      if (/\/(?:page|genre|genres|category|tag|author|search|login|register|contact|about)(?:\/|$)/i.test(new URL(href).pathname)) return;

      const $card = $a.closest('article, .video-item, .video, .item, .thumb, .post, .result-item, .animposx, .bs, .entry, .grid-item, .movie, li');
      const $container = $card.length ? $card : $a;
      const poster = imageFromCard($, $container, $a, base);
      if (!poster) return;

      const title = clean(
        $container.find('.title, .tt, .entry-title, .video-title, .name, h2, h3, h4').first().text()
      ) || clean($a.attr('title')) || clean($a.find('img').first().attr('alt')) || clean($a.text());
      if (!title || title.length < 2 || /^(watch|play|view|more|next|previous)$/i.test(title)) return;

      const genres = $container.find('.genre a, .genres a, .sgeneros a, a[rel="tag"], .tags a, a[href*="/genre/"], a[href*="/tag/"]')
        .map((__, tag) => clean($(tag).text())).get().filter(Boolean).slice(0, 16);
      const description = clean($container.find('.description, .excerpt, .summary').first().text());
      const item = { key: href, name: title, poster, genres, description };
      if (hasMinorCodedContent(item)) return;
      seen.add(href);
      out.push(item);
    });
    if (out.length >= 100) return false;
  }
  return out;
}

function buildPageUrl(base, pathname, page) {
  const root = base.replace(/\/$/, '');
  if (page <= 1) return `${root}${pathname || '/'}`;
  const cleanPath = pathname || '/';
  if (cleanPath.endsWith('/')) return `${root}${cleanPath}page/${page}/`;
  return `${root}${cleanPath}/page/${page}/`;
}

function genericCandidateUrls(config, { search, genre, page }) {
  const base = config.base.replace(/\/$/, '');
  const p = (path) => buildPageUrl(base, path, page);
  if (search) {
    const q = encodeURIComponent(search);
    return [
      `${base}/?s=${q}${page > 1 ? `&paged=${page}` : ''}`,
      `${base}/?search=${q}${page > 1 ? `&page=${page}` : ''}`,
      `${base}/search/${encodeURIComponent(search).replace(/%20/g, '+')}/${page > 1 ? `page/${page}/` : ''}`,
    ];
  }
  if (genre) {
    const g = slugify(genre);
    const paths = config.genrePaths || ['/genre/{g}/', '/genres/{g}/', '/tag/{g}/', '/category/{g}/'];
    return paths.flatMap((path) => [p(path.replace('{g}', g)), p(path.replace('{g}', g).replace(/\/$/, ''))]);
  }
  const paths = [config.listPath || '/', ...(config.fallbackListPaths || ['/videos/', '/latest/', '/hentai/'])];
  return [...new Set(paths.flatMap((path) => [p(path), p(path.replace(/\/$/, ''))]))];
}

async function fetchFirstCatalog(config, args) {
  const urls = genericCandidateUrls(config, args);
  let lastError;
  for (const url of urls) {
    try {
      const html = await getHtml(url, { Referer: config.base });
      const items = findCards(html, config.base);
      if (items.length) return items;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return [];
}

function pageUrlList(base, key) {
  return [absoluteUrl(key, base), absoluteUrl(key, base)].filter(Boolean);
}

async function extractPageMeta(url, config) {
  const html = await getHtml(url, { Referer: config.base });
  const $ = cheerio.load(html);
  const name = textFromMeta($, ['meta[property="og:title"]', 'meta[name="twitter:title"]', 'h1', 'title']);
  const poster = absoluteUrl(textFromMeta($, ['meta[property="og:image"]', 'meta[name="twitter:image"]']), url);
  const description = textFromMeta($, ['meta[property="og:description"]', 'meta[name="description"]']) ||
    clean($('.entry-content p, .content p, .description p, .wp-content p, .summary').first().text());
  const genres = [...new Set($('.sgeneros a, .genres a, .genre a, a[rel="tag"], .tags a, [class*="genre"] a, a[href*="/genre/"], a[href*="/tag/"]')
    .map((_, el) => clean($(el).text())).get().filter((x) => x && x.length < 40))].slice(0, 20);
  const episodes = [];
  const seen = new Set();
  // Read episode links only from likely playlist containers; don't turn recommendations into episodes.
  $('.episodes a[href], #episodes a[href], .episodios a[href], .episode-list a[href], .playlist a[href], .eplist a[href], [class*="episode-list"] a[href]')
    .each((_, el) => {
      const $a = $(el);
      const href = absoluteUrl($a.attr('href'), url);
      const label = clean($a.text() || $a.attr('title'));
      if (!href || href === url || seen.has(href) || !label || isImageOrNoiseUrl(href)) return;
      seen.add(href);
      episodes.push({ key: href, title: label });
    });
  return { name: name || config.name, poster, background: poster, description, genres, episodes, html };
}

function extractMediaUrls(text) {
  const source = String(text || '').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  const result = new Set();
  const pattern = /https?:\\?\/\\?\/[^"'\s<>\\)]+?\.(?:m3u8|mp4|mpd)(?:\?[^"'\s<>\\)]*)?/gi;
  for (const match of source.matchAll(pattern)) {
    const url = match[0].replace(/\\\//g, '/').replace(/\\u0026/g, '&');
    if (!isImageOrNoiseUrl(url)) result.add(url);
  }
  return [...result];
}

function extractCandidateUrls(html, base) {
  const $ = cheerio.load(html);
  const candidates = new Set(extractMediaUrls(html));
  $('video source, video, source').each((_, el) => {
    const src = absoluteUrl($(el).attr('src') || $(el).attr('data-src'), base);
    if (src && /\.(?:m3u8|mp4|mpd)(?:[?#]|$)/i.test(src)) candidates.add(src);
  });
  $('iframe').each((_, el) => {
    const src = absoluteUrl($(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src'), base);
    if (src && !isImageOrNoiseUrl(src)) candidates.add(src);
  });
  for (const key of ['data-src', 'data-video', 'data-embed', 'data-player']) {
    $(`[${key}]`).each((_, el) => {
      const src = absoluteUrl($(el).attr(key), base);
      if (src && !isImageOrNoiseUrl(src)) candidates.add(src);
    });
  }
  return [...candidates].filter((url) => /^https?:\/\//i.test(url));
}

async function resolveStreams(providerName, candidates, referer) {
  const streams = [];
  const seen = new Set();
  const add = (url, title, direct) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    if (direct) {
      streams.push({
        name: providerName,
        title,
        url,
        behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: referer, 'User-Agent': UA } } },
      });
    } else {
      streams.push({ name: providerName, title: `${title} (browser)`, externalUrl: url });
    }
  };

  for (const candidate of candidates.slice(0, 8)) {
    if (/\.(?:m3u8|mp4|mpd)(?:[?#]|$)/i.test(candidate)) {
      add(candidate, /\.m3u8/i.test(candidate) ? 'HLS' : /\.mpd/i.test(candidate) ? 'DASH' : 'MP4', true);
      continue;
    }
    try {
      const html = await getHtml(candidate, { Referer: referer });
      const media = extractMediaUrls(html);
      if (media.length) media.forEach((url) => add(url, /\.m3u8/i.test(url) ? 'HLS' : 'MP4', true));
      else add(candidate, 'Embed', false);
    } catch {
      add(candidate, 'Embed', false);
    }
  }
  return streams;
}

function genericProvider(config) {
  return {
    id: config.id,
    name: config.name,
    base: config.base,
    async catalog({ search = '', genre = '', page = 1 }) {
      // Genre is routed through provider-native genre/tag/category URLs where available.
      return fetchFirstCatalog(config, { search, genre, page });
    },
    async meta(key) {
      const data = await extractPageMeta(key, config);
      if (!data.poster) {
        const html = data.html;
        const cards = findCards(html, config.base);
        if (cards[0]) data.poster = cards[0].poster;
      }
      delete data.html;
      return data;
    },
    async streams(key) {
      const html = await getHtml(key, { Referer: config.base });
      return resolveStreams(config.name, extractCandidateUrls(html, key), key);
    },
  };
}

function wpProvider(config) {
  return genericProvider({
    ...config,
    listPath: config.listPath || '/',
    genrePaths: config.genrePaths || ['/genre/{g}/', '/genres/{g}/', '/tag/{g}/', '/category/{g}/'],
    fallbackListPaths: config.fallbackListPaths || ['/tvshows/', '/videos/', '/latest/'],
  });
}

// Generic HTML adapters are deliberately tolerant because these sites change markup often.
// Use environment variables to update domains if a provider changes its public domain.
const hentaimama = wpProvider({
  id: 'hentaimama', name: 'HentaiMama', base: process.env.HENTAIMAMA_BASE || 'https://hentaimama.io',
  listPath: '/tvshows/', fallbackListPaths: ['/videos/', '/'],
  genrePaths: ['/genre/{g}/', '/genres/{g}/', '/tag/{g}/', '/category/{g}/'],
});
const hentaitv = wpProvider({
  id: 'hentaitv', name: 'Hentai.TV', base: process.env.HENTAITV_BASE || 'https://hentai.tv',
  listPath: '/', fallbackListPaths: ['/hentai/', '/latest/'],
});
const hentaigasm = wpProvider({
  id: 'hentaigasm', name: 'Hentaigasm', base: process.env.HENTAIGASM_BASE || 'https://hentaigasm.com',
  listPath: '/', fallbackListPaths: ['/videos/', '/latest/'],
  genrePaths: ['/genre/{g}/', '/tag/{g}/', '/category/{g}/', '/videos/genre/{g}/'],
});
const hentaismile = wpProvider({
  id: 'hentaismile', name: 'HentaiSmile', base: process.env.HENTAISMILE_BASE || 'https://hentaismile.com',
  listPath: '/', fallbackListPaths: ['/videos/', '/latest/'],
  genrePaths: ['/genre/{g}/', '/tag/{g}/', '/category/{g}/', '/genres/{g}/'],
});
const hentaicity = wpProvider({
  id: 'hentaicity', name: 'HentaiCity', base: process.env.HENTAICITY_BASE || 'https://hentaicity.com',
  listPath: '/', fallbackListPaths: ['/videos/', '/latest/', '/anime/'],
  genrePaths: ['/genre/{g}/', '/category/{g}/', '/tag/{g}/', '/genres/{g}/'],
});

// Hanime JSON API adapter, kept as a separate source.
const HANIME_SEARCH = process.env.HANIME_SEARCH_URL || 'https://search.htv-services.com/search';
const HANIME_API = process.env.HANIME_API || 'https://hanime.tv/api/v8/video?id=';
const HANIME_HEADERS = { Referer: 'https://hanime.tv/', Origin: 'https://hanime.tv', Accept: 'application/json' };
const hanime = {
  id: 'hanime', name: 'Hanime', base: 'https://hanime.tv',
  async video(slug) {
    return cached(`hanime:${slug}`, DETAIL_TTL, async () => (await http.get(`${HANIME_API}${encodeURIComponent(slug)}`, { headers: HANIME_HEADERS })).data);
  },
  async catalog({ search = '', genre = '', page = 1 }) {
    const payload = {
      search_text: search,
      tags: genre ? [genre.toLowerCase()] : [],
      tags_mode: 'AND', brands: [], blacklist: [],
      order_by: 'created_at_unix', ordering: 'desc',
      page: Math.max(0, page - 1),
    };
    const { data } = await http.post(HANIME_SEARCH, payload, {
      headers: { ...HANIME_HEADERS, 'Content-Type': 'application/json' },
    });
    const hits = typeof data.hits === 'string' ? JSON.parse(data.hits) : (data.hits || []);
    return hits.map((hit) => ({
      key: hit.slug,
      name: clean(hit.name),
      poster: hit.poster_url || hit.cover_url || '',
      description: stripHtml(hit.description),
      genres: (hit.tags || []).map((tag) => typeof tag === 'string' ? tag : tag.text).filter(Boolean).slice(0, 12),
    })).filter((item) => item.name && item.poster && !hasMinorCodedContent(item));
  },
  async meta(slug) {
    const data = await this.video(slug);
    const video = data.hentai_video || {};
    const franchise = data.hentai_franchise_hentai_videos || [];
    const genres = (data.hentai_tags || []).map((tag) => tag.text).filter(Boolean).slice(0, 20);
    const meta = {
      name: clean(video.name) || slug,
      poster: video.poster_url || video.cover_url || '',
      background: video.cover_url || video.poster_url || '',
      description: stripHtml(video.description),
      genres,
      episodes: franchise.length > 1 ? franchise.map((item) => ({ key: item.slug, title: item.name })) : [],
    };
    if (hasMinorCodedContent(meta)) return { ...meta, blocked: true };
    return meta;
  },
  async streams(slug) {
    const data = await this.video(slug);
    const servers = (data.videos_manifest && data.videos_manifest.servers) || [];
    return servers.flatMap((server) => (server.streams || []).map((stream) => ({ ...stream, server: server.name })))
      .filter((stream) => stream.url && /\.(?:m3u8|mp4|mpd)(?:[?#]|$)/i.test(stream.url))
      .sort((a, b) => (b.height || 0) - (a.height || 0))
      .map((stream) => ({
        name: 'Hanime', title: `${stream.height || '?'}p ${stream.server || ''}`.trim(), url: stream.url,
        behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: 'https://hanime.tv/', 'User-Agent': UA } } },
      }));
  },
};

const PROVIDERS = { hentaimama, hentaitv, hanime, hentaigasm, hentaismile, hentaicity };
const EXTRA = [
  { name: 'search', isRequired: false },
  { name: 'genre', isRequired: false, options: GENRES, optionsLimit: 1 },
  { name: 'skip', isRequired: false },
];
const catalogs = [
  { type: CONTENT_TYPE, id: 'hn-all', name: 'Hentai Hub - All Providers', extra: EXTRA },
  ...Object.values(PROVIDERS).map((provider) => ({
    type: CONTENT_TYPE, id: `hn-${provider.id}`, name: provider.name, extra: EXTRA,
  })),
];

const manifest = {
  id: 'community.hentai.hub',
  version: '2.0.0',
  name: 'Hentai Hub',
  description: 'Adult anime catalog across multiple providers. Adults 18+ only.',
  resources: ['catalog', 'meta', 'stream'],
  types: [CONTENT_TYPE],
  idPrefixes: ['hn:'],
  catalogs,
  behaviorHints: { adult: true, configurable: false },
};
const builder = new addonBuilder(manifest);

const makeId = (providerId, key) => `hn:${providerId}:${encodeKey(key)}`;
function parseId(id) {
  const parts = String(id || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'hn') return null;
  try { return { providerId: parts[1], key: decodeKey(parts[2]) }; } catch { return null; }
}
function providerForCatalog(id) {
  if (id === 'hn-all') return Object.values(PROVIDERS);
  const name = String(id || '').replace(/^hn-/, '');
  return PROVIDERS[name] ? [PROVIDERS[name]] : [];
}
builder.defineCatalogHandler(async ({ id, extra = {} }) => {
  const selected = providerForCatalog(id);
  if (!selected.length) return { metas: [], cacheMaxAge: 300 };
  const search = clean(extra.search);
  const genre = clean(extra.genre);
  const skip = Math.max(0, Number(extra.skip) || 0);
  // A source page is about 20 items. For the combined catalog, offset across all sources.
  const combinedSourcePageSize = SOURCE_PAGE_SIZE * selected.length;
  const startPage = Math.floor(skip / combinedSourcePageSize) + 1;
  const offsetWithinFetchedBatch = skip % combinedSourcePageSize;
  const pageCount = Math.ceil((offsetWithinFetchedBatch + ITEMS_PER_REQUEST) / combinedSourcePageSize);

  const perProvider = await Promise.allSettled(selected.map(async (provider) => {
    // Fetch sequentially per provider to avoid firing 30 requests at all sites at once.
    const lists = [];
    for (let index = 0; index < pageCount; index++) {
      try {
        lists.push(await provider.catalog({ search, genre, page: startPage + index }));
      } catch (error) {
        console.error(`[${provider.name}] catalog page error: ${error.message}`);
        lists.push([]);
      }
    }
    const flattened = lists.flat();
    const unique = [];
    const seen = new Set();
    for (const item of flattened) {
      if (!item || !item.key || !item.name || !item.poster || hasMinorCodedContent(item)) continue;
      const key = String(item.key);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push({ ...item, providerId: provider.id });
    }
    return unique;
  }));

  const lists = perProvider.map((result) => result.status === 'fulfilled' ? result.value : []);
  const combined = [];
  // Interleave the providers so one source does not dominate the combined catalog.
  for (let i = 0; lists.some((list) => i < list.length); i++) {
    for (const list of lists) if (list[i]) combined.push(list[i]);
  }
  const metas = combined.slice(offsetWithinFetchedBatch, offsetWithinFetchedBatch + ITEMS_PER_REQUEST).map((item) => ({
    id: makeId(item.providerId, item.key),
    type: CONTENT_TYPE,
    name: item.name,
    poster: item.poster,
    posterShape: 'poster',
    ...(item.description ? { description: item.description } : {}),
    ...(item.genres && item.genres.length ? { genres: item.genres } : {}),
  }));
  return { metas, cacheMaxAge: Math.floor(CATALOG_TTL / 1000) };
});

builder.defineMetaHandler(async ({ id }) => {
  const parsed = parseId(id);
  if (!parsed) return { meta: null };
  const provider = PROVIDERS[parsed.providerId];
  if (!provider) return { meta: null };
  try {
    const data = await provider.meta(parsed.key);
    if (!data || data.blocked || hasMinorCodedContent(data)) return { meta: null };
    const episodes = Array.isArray(data.episodes) && data.episodes.length ? data.episodes : [{ key: parsed.key, title: data.name }];
    const uniqueEpisodes = [];
    const seen = new Set();
    for (const episode of episodes) {
      if (!episode.key || seen.has(episode.key)) continue;
      seen.add(episode.key);
      uniqueEpisodes.push(episode);
    }
    const releasedBase = Date.parse('2000-01-01T00:00:00.000Z');
    const videos = uniqueEpisodes.map((episode, index) => ({
      id: makeId(parsed.providerId, episode.key),
      title: clean(episode.title) || `Part ${index + 1}`,
      season: 1,
      episode: index + 1,
      released: new Date(releasedBase + index * 86400000).toISOString(),
    }));
    return {
      meta: {
        id,
        type: CONTENT_TYPE,
        name: clean(data.name) || 'Untitled',
        ...(data.poster ? { poster: data.poster } : {}),
        ...(data.background || data.poster ? { background: data.background || data.poster } : {}),
        ...(data.description ? { description: data.description } : {}),
        ...(data.genres && data.genres.length ? { genres: data.genres } : {}),
        videos,
      },
      cacheMaxAge: Math.floor(DETAIL_TTL / 1000),
    };
  } catch (error) {
    console.error(`[${provider.name}] metadata error: ${error.message}`);
    return { meta: null, cacheMaxAge: 60 };
  }
});

builder.defineStreamHandler(async ({ id }) => {
  const parsed = parseId(id);
  if (!parsed) return { streams: [] };
  const provider = PROVIDERS[parsed.providerId];
  if (!provider) return { streams: [] };
  try {
    const streams = await cached(`streams:${parsed.providerId}:${parsed.key}`, STREAM_TTL, () => provider.streams(parsed.key));
    return { streams: (streams || []).slice(0, 20), cacheMaxAge: Math.floor(STREAM_TTL / 1000) };
  } catch (error) {
    console.error(`[${provider.name}] stream error: ${error.message}`);
    return { streams: [], cacheMaxAge: 60 };
  }
});

serveHTTP(builder.getInterface(), { port: PORT });
console.log(`Hentai Hub v2 listening on port ${PORT}`);
console.log(`Manifest: http://127.0.0.1:${PORT}/manifest.json`);
