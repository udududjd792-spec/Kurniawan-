'use strict';

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

const PORT = Number(process.env.PORT || 3000);
const TYPE = 'other';
const UA = process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36';
const CATALOG_TTL = Number(process.env.CACHE_CATALOG_SECONDS || 600) * 1000;
const DETAIL_TTL = Number(process.env.CACHE_DETAIL_SECONDS || 1800) * 1000;
const STREAM_TTL = Number(process.env.CACHE_STREAM_SECONDS || 180) * 1000;
const PAGE_SIZE = 20;
const PAGE_LIMIT = 100;
const MINOR_TERMS = /\b(loli(?:con)?|shota(?:con)?|underage|child porn|young girl|young boy)\b/i;
const GENRES = ['3D','Ahegao','Anal','BDSM','Big Breasts','Blowjob','Bondage','Comedy','Cosplay','Creampie','Dark Skin','Demon','Doujin','Exhibition','Fantasy','Femdom','Fetish','Footjob','Futanari','Gangbang','Glasses','Group','Harem','Horror','Incest','Maid','Masturbation','Milf','Monster','Motion Anime','Netorare','Nurse','Office Lady','Romance','School','Sci-Fi','Succubus','Swimsuit','Tentacle','Threesome','Uncensored','Vanilla','Virgin','X-Ray','Yuri'];

const http = axios.create({
  timeout: Number(process.env.HTTP_TIMEOUT_MS || 15000),
  maxRedirects: 5,
  headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  validateStatus: status => status >= 200 && status < 400,
});

const cache = new Map();
async function cached(key, ttl, fn) {
  const entry = cache.get(key);
  if (entry && entry.expires > Date.now()) return entry.value;
  const value = await fn();
  cache.set(key, { value, expires: Date.now() + ttl });
  if (cache.size > 1500) {
    for (const [k, v] of cache) if (v.expires <= Date.now()) cache.delete(k);
    while (cache.size > 1500) cache.delete(cache.keys().next().value);
  }
  return value;
}

const clean = v => String(v || '').replace(/\s+/g, ' ').trim();
const stripHtml = v => clean(String(v || '').replace(/<[^>]*>/g, ' '));
const slugify = v => clean(v).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const encodeKey = v => Buffer.from(String(v), 'utf8').toString('base64url');
const decodeKey = v => Buffer.from(String(v), 'base64url').toString('utf8');

function absUrl(value, base) {
  try {
    if (!value) return '';
    const u = new URL(String(value).replace(/&amp;/g, '&'), base);
    return ['http:', 'https:'].includes(u.protocol) ? u.href : '';
  } catch { return ''; }
}
function blocked(item) {
  return MINOR_TERMS.test([item.name, item.description, ...(item.genres || [])].join(' '));
}
function isNoise(url) {
  return /\.(?:jpe?g|png|gif|webp|svg|css|js|ico|woff2?)(?:[?#]|$)|wp-json|wp-content|gravatar|schema\.org/i.test(url || '');
}
async function getHtml(url, referer) {
  return cached(`html:${url}`, CATALOG_TTL, async () => {
    const response = await http.get(url, { headers: referer ? { Referer: referer } : {}, responseType: 'text' });
    return String(response.data || '');
  });
}
function metaText($, selectors) {
  for (const selector of selectors) {
    const n = $(selector).first();
    const value = clean(n.attr('content') || n.text());
    if (value) return value;
  }
  return '';
}
function cardPoster($, $card, $a, base) {
  const $img = ($card.find('img').first().length ? $card.find('img').first() : $a.find('img').first());
  let src = $img.attr('data-src') || $img.attr('data-lazy-src') || $img.attr('data-original') || $img.attr('data-thumb') || $img.attr('src') || '';
  if (!src) {
    const style = $card.attr('style') || $a.attr('style') || '';
    const match = style.match(/background-image\s*:\s*url\(["']?([^"')]+)["']?\)/i);
    if (match) src = match[1];
  }
  return absUrl(src, base);
}
function parseCards(html, base) {
  const $ = cheerio.load(html);
  const out = [];
  const seen = new Set();
  const selectors = ['article a[href]', '.video-item a[href]', '.video a[href]', '.item a[href]', '.thumb a[href]', '.post a[href]', '.result-item a[href]', '.animposx a[href]', '.bs a[href]', '.entry a[href]', '.grid-item a[href]', '.movie a[href]', 'li a[href]', 'a[href]'];
  for (const selector of selectors) {
    $(selector).each((_, el) => {
      const $a = $(el);
      const href = absUrl($a.attr('href'), base);
      if (!href || seen.has(href) || isNoise(href)) return;
      let parsed;
      try { parsed = new URL(href); } catch { return; }
      if (parsed.hostname !== new URL(base).hostname) return;
      if (/\/(?:page|genre|genres|category|tag|author|search|login|register|contact|about)(?:\/|$)/i.test(parsed.pathname)) return;
      const $closest = $a.closest('article,.video-item,.video,.item,.thumb,.post,.result-item,.animposx,.bs,.entry,.grid-item,.movie,li');
      const $card = $closest.length ? $closest : $a;
      const poster = cardPoster($, $card, $a, base);
      if (!poster) return;
      const name = clean($card.find('.title,.tt,.entry-title,.video-title,.name,h2,h3,h4').first().text()) || clean($a.attr('title')) || clean($a.find('img').first().attr('alt')) || clean($a.text());
      if (!name || name.length < 2 || /^(watch|play|view|more|next|previous)$/i.test(name)) return;
      const genres = $card.find('.genre a,.genres a,.sgeneros a,a[rel="tag"],.tags a,a[href*="/genre/"],a[href*="/tag/"]').map((__, tag) => clean($(tag).text())).get().filter(Boolean).slice(0, 16);
      const description = clean($card.find('.description,.excerpt,.summary').first().text());
      const item = { key: href, name, poster, genres, description };
      if (blocked(item)) return;
      seen.add(href);
      out.push(item);
    });
    if (out.length >= PAGE_LIMIT) break;
  }
  return out;
}
function pagePath(base, path, page) {
  const root = base.replace(/\/$/, '');
  const p = path || '/';
  if (page <= 1) return `${root}${p.startsWith('/') ? p : `/${p}`}`;
  return `${root}${p.startsWith('/') ? p : `/${p}`}${p.endsWith('/') ? '' : '/'}page/${page}/`;
}
function candidatePages(config, { search, genre, page }) {
  const base = config.base.replace(/\/$/, '');
  if (search) {
    const q = encodeURIComponent(search);
    return [`${base}/?s=${q}${page > 1 ? `&paged=${page}` : ''}`, `${base}/?search=${q}${page > 1 ? `&page=${page}` : ''}`, `${base}/search/${q.replace(/%20/g, '+')}/${page > 1 ? `page/${page}/` : ''}`];
  }
  if (genre) {
    const g = slugify(genre);
    return (config.genrePaths || ['/genre/{g}/', '/tag/{g}/', '/category/{g}/']).map(path => pagePath(base, path.replace('{g}', g), page));
  }
  return (config.listPaths || ['/']).map(path => pagePath(base, path, page));
}
async function fetchCatalog(config, args) {
  let lastError;
  for (const url of candidatePages(config, args)) {
    try {
      const html = await getHtml(url, config.base);
      const items = parseCards(html, config.base);
      if (items.length) return items;
    } catch (e) {
      lastError = e;
      // Try the next known path quietly; only report if every candidate failed.
    }
  }
  if (lastError) throw lastError;
  return [];
}
async function pageMeta(url, config) {
  const html = await getHtml(url, config.base);
  const $ = cheerio.load(html);
  const name = metaText($, ['meta[property="og:title"]', 'meta[name="twitter:title"]', 'h1', 'title']);
  const poster = absUrl(metaText($, ['meta[property="og:image"]', 'meta[name="twitter:image"]']), url);
  const description = metaText($, ['meta[property="og:description"]', 'meta[name="description"]']) || clean($('.entry-content p,.content p,.description p,.wp-content p,.summary').first().text());
  const genres = [...new Set($('.sgeneros a,.genres a,.genre a,a[rel="tag"],.tags a,[class*="genre"] a,a[href*="/genre/"],a[href*="/tag/"]').map((_, el) => clean($(el).text())).get().filter(x => x && x.length < 40))].slice(0, 20);
  const episodes = [];
  const seen = new Set();
  $('.episodes a[href],#episodes a[href],.episodios a[href],.episode-list a[href],.playlist a[href],.eplist a[href],[class*="episode-list"] a[href]').each((_, el) => {
    const $a = $(el); const key = absUrl($a.attr('href'), url); const title = clean($a.text() || $a.attr('title'));
    if (!key || key === url || seen.has(key) || !title || isNoise(key)) return;
    seen.add(key); episodes.push({ key, title });
  });
  return { name: name || config.name, poster, background: poster, description, genres, episodes };
}
function extractMedia(html) {
  const source = String(html || '').replace(/\\\//g, '/').replace(/&amp;/g, '&').replace(/\\u0026/g, '&');
  const urls = new Set();
  const pattern = /https?:\\?\/\\?\/[^"'\s<>\\)]+?\.(?:m3u8|mp4|mpd)(?:\?[^"'\s<>\\)]*)?/gi;
  for (const match of source.matchAll(pattern)) urls.add(match[0].replace(/\\\//g, '/'));
  return [...urls].filter(url => !isNoise(url));
}
function candidateStreams(html, base) {
  const $ = cheerio.load(html);
  const urls = new Set(extractMedia(html));
  $('video source,video,source').each((_, el) => {
    const src = absUrl($(el).attr('src') || $(el).attr('data-src'), base);
    if (src && /\.(?:m3u8|mp4|mpd)(?:[?#]|$)/i.test(src)) urls.add(src);
  });
  $('iframe,[data-src],[data-video],[data-embed],[data-player]').each((_, el) => {
    for (const key of ['src','data-src','data-video','data-embed','data-player']) {
      const src = absUrl($(el).attr(key), base);
      if (src && !isNoise(src)) urls.add(src);
    }
  });
  return [...urls].filter(url => /^https?:\/\//i.test(url));
}
async function resolveStreams(providerName, candidates, referer) {
  const streams = []; const seen = new Set();
  const add = (url, title, direct) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    if (direct) streams.push({ name: providerName, title, url, behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: referer, 'User-Agent': UA } } } });
    else streams.push({ name: providerName, title: `${title} (browser)`, externalUrl: url });
  };
  for (const url of candidates.slice(0, 8)) {
    if (/\.(?:m3u8|mp4|mpd)(?:[?#]|$)/i.test(url)) {
      add(url, /\.m3u8/i.test(url) ? 'HLS' : /\.mpd/i.test(url) ? 'DASH' : 'MP4', true);
      continue;
    }
    try {
      const html = await getHtml(url, referer);
      const media = extractMedia(html);
      if (media.length) media.forEach(mediaUrl => add(mediaUrl, /\.m3u8/i.test(mediaUrl) ? 'HLS' : /\.mpd/i.test(mediaUrl) ? 'DASH' : 'MP4', true));
      else add(url, 'Embed', false);
    } catch { add(url, 'Embed', false); }
  }
  return streams;
}
function htmlProvider(config) {
  return {
    ...config,
    async catalog(args) { return fetchCatalog(config, args); },
    async meta(key) {
      const data = await pageMeta(key, config);
      if (!data.poster) {
        const cards = parseCards(await getHtml(key, config.base), config.base);
        if (cards[0]) data.poster = cards[0].poster;
      }
      return data;
    },
    async streams(key) { return resolveStreams(config.name, candidateStreams(await getHtml(key, config.base), key), key); },
  };
}

const hentaimama = htmlProvider({ id: 'hentaimama', name: 'HentaiMama', base: process.env.HENTAIMAMA_BASE || 'https://hentaimama.io', listPaths: ['/tvshows/', '/videos/', '/'], genrePaths: ['/genre/{g}/', '/genres/{g}/', '/tag/{g}/', '/category/{g}/'] });
const hentaitv = htmlProvider({ id: 'hentaitv', name: 'Hentai.TV', base: process.env.HENTAITV_BASE || 'https://hentai.tv', listPaths: ['/'], genrePaths: ['/genre/{g}/', '/tag/{g}/', '/category/{g}/'] });
const hentaigasm = htmlProvider({ id: 'hentaigasm', name: 'Hentaigasm', base: process.env.HENTAIGASM_BASE || 'https://hentaigasm.com', listPaths: ['/'], genrePaths: ['/genre/{g}/', '/tag/{g}/', '/category/{g}/'] });
const hentaismile = htmlProvider({ id: 'hentaismile', name: 'HentaiSmile', base: process.env.HENTAISMILE_BASE || 'https://hentaismile.com', listPaths: ['/'], genrePaths: ['/genre/{g}/', '/tag/{g}/', '/category/{g}/'] });
const hentaicity = htmlProvider({ id: 'hentaicity', name: 'HentaiCity', base: process.env.HENTAICITY_BASE || 'https://www.hentaicity.com', listPaths: ['/'], genrePaths: ['/genre/{g}/', '/tag/{g}/', '/category/{g}/'] });

// Hanime's search endpoint is the service root, not /search.
const HANIME_SEARCH = process.env.HANIME_SEARCH_URL || 'https://search.htv-services.com/';
const HANIME_API = process.env.HANIME_API || 'https://hanime.tv/api/v8/video?id=';
const HANIME_HEADERS = { Referer: 'https://hanime.tv/', Origin: 'https://hanime.tv', Accept: 'application/json' };
const hanime = {
  id: 'hanime', name: 'Hanime', base: 'https://hanime.tv',
  async video(slug) {
    return cached(`hanime:${slug}`, DETAIL_TTL, async () => (await http.get(`${HANIME_API}${encodeURIComponent(slug)}`, { headers: HANIME_HEADERS })).data);
  },
  async catalog({ search = '', genre = '', page = 1 }) {
    const payload = { search_text: search, tags: genre ? [genre.toLowerCase()] : [], tags_mode: 'AND', brands: [], blacklist: [], order_by: 'created_at_unix', ordering: 'desc', page: Math.max(0, page - 1) };
    const { data } = await http.post(HANIME_SEARCH, payload, { headers: { ...HANIME_HEADERS, 'Content-Type': 'application/json;charset=UTF-8' } });
    const hits = typeof data.hits === 'string' ? JSON.parse(data.hits) : (data.hits || []);
    return hits.map(hit => ({ key: hit.slug, name: clean(hit.name), poster: hit.poster_url || hit.cover_url || '', description: stripHtml(hit.description), genres: (hit.tags || []).map(tag => typeof tag === 'string' ? tag : tag.text).filter(Boolean).slice(0, 12) })).filter(item => item.key && item.name && item.poster && !blocked(item));
  },
  async meta(slug) {
    const data = await this.video(slug); const video = data.hentai_video || {}; const franchise = data.hentai_franchise_hentai_videos || [];
    const meta = { name: clean(video.name) || slug, poster: video.poster_url || video.cover_url || '', background: video.cover_url || video.poster_url || '', description: stripHtml(video.description), genres: (data.hentai_tags || []).map(tag => tag.text).filter(Boolean).slice(0, 20), episodes: franchise.length > 1 ? franchise.map(item => ({ key: item.slug, title: item.name })) : [] };
    return blocked(meta) ? { ...meta, blocked: true } : meta;
  },
  async streams(slug) {
    const data = await this.video(slug); const servers = (data.videos_manifest && data.videos_manifest.servers) || [];
    return servers.flatMap(server => (server.streams || []).map(stream => ({ ...stream, server: server.name }))).filter(stream => stream.url && /\.(?:m3u8|mp4|mpd)(?:[?#]|$)/i.test(stream.url)).sort((a,b) => (b.height || 0) - (a.height || 0)).map(stream => ({ name: 'Hanime', title: `${stream.height || '?'}p ${stream.server || ''}`.trim(), url: stream.url, behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: 'https://hanime.tv/', 'User-Agent': UA } } } }));
  },
};

const PROVIDERS = { hentaimama, hentaitv, hanime, hentaigasm, hentaismile, hentaicity };
const EXTRA = [{ name: 'search', isRequired: false }, { name: 'genre', isRequired: false, options: GENRES, optionsLimit: 1 }, { name: 'skip', isRequired: false }];
const catalogs = [{ type: TYPE, id: 'hn-all', name: 'Hentai Hub - All Providers', extra: EXTRA }, ...Object.values(PROVIDERS).map(p => ({ type: TYPE, id: `hn-${p.id}`, name: p.name, extra: EXTRA }))];
const manifest = { id: 'community.hentai.hub', version: '2.1.0', name: 'Hentai Hub', description: 'Adult anime catalog across multiple providers. Adults 18+ only.', resources: ['catalog','meta','stream'], types: [TYPE], idPrefixes: ['hn:'], catalogs, behaviorHints: { adult: true, configurable: false } };
const builder = new addonBuilder(manifest);
const makeId = (providerId, key) => `hn:${providerId}:${encodeKey(key)}`;
function parseId(id) {
  const parts = String(id || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'hn') return null;
  try { return { providerId: parts[1], key: decodeKey(parts[2]) }; } catch { return null; }
}
function selectedProviders(id) {
  if (id === 'hn-all') return Object.values(PROVIDERS);
  const name = String(id || '').replace(/^hn-/, '');
  return PROVIDERS[name] ? [PROVIDERS[name]] : [];
}

builder.defineCatalogHandler(async ({ id, extra = {} }) => {
  const selected = selectedProviders(id);
  if (!selected.length) return { metas: [], cacheMaxAge: 300 };
  const search = clean(extra.search); const genre = clean(extra.genre); const skip = Math.max(0, Number(extra.skip) || 0);
  const batchSize = PAGE_SIZE * selected.length;
  const startPage = Math.floor(skip / batchSize) + 1;
  const offset = skip % batchSize;
  const pagesNeeded = Math.min(5, Math.ceil((offset + PAGE_SIZE) / batchSize));
  const providerLists = await Promise.all(selected.map(async provider => {
    const list = [];
    for (let index = 0; index < pagesNeeded; index++) {
      const page = startPage + index;
      try { list.push(...await provider.catalog({ search, genre, page })); }
      catch (e) { console.error(`[${provider.name}] catalog failed: ${e.code || e.response?.status || e.message}`); break; }
    }
    const seen = new Set();
    return list.filter(item => {
      const key = String(item.key || '');
      if (!key || !item.name || !item.poster || blocked(item) || seen.has(key)) return false;
      seen.add(key); return true;
    }).map(item => ({ ...item, providerId: provider.id }));
  }));
  const combined = [];
  for (let i = 0; providerLists.some(list => i < list.length); i++) for (const list of providerLists) if (list[i]) combined.push(list[i]);
  const metas = combined.slice(offset, offset + PAGE_SIZE).map(item => ({ id: makeId(item.providerId, item.key), type: TYPE, name: item.name, poster: item.poster, posterShape: 'poster', ...(item.description ? { description: item.description } : {}), ...(item.genres?.length ? { genres: item.genres } : {}) }));
  return { metas, cacheMaxAge: Math.floor(CATALOG_TTL / 1000) };
});

builder.defineMetaHandler(async ({ id }) => {
  const parsed = parseId(id); if (!parsed) return { meta: null };
  const provider = PROVIDERS[parsed.providerId]; if (!provider) return { meta: null };
  try {
    const data = await provider.meta(parsed.key);
    if (!data || data.blocked || blocked(data)) return { meta: null };
    const episodes = Array.isArray(data.episodes) && data.episodes.length ? data.episodes : [{ key: parsed.key, title: data.name }];
    const seen = new Set();
    const videos = episodes.filter(ep => ep.key && !seen.has(ep.key) && seen.add(ep.key)).map((ep, index) => ({ id: makeId(parsed.providerId, ep.key), title: clean(ep.title) || `Part ${index + 1}`, season: 1, episode: index + 1, released: new Date(Date.UTC(2000, 0, 1 + index)).toISOString() }));
    return { meta: { id, type: TYPE, name: clean(data.name) || 'Untitled', ...(data.poster ? { poster: data.poster } : {}), ...(data.background || data.poster ? { background: data.background || data.poster } : {}), ...(data.description ? { description: data.description } : {}), ...(data.genres?.length ? { genres: data.genres } : {}), videos }, cacheMaxAge: Math.floor(DETAIL_TTL / 1000) };
  } catch (e) { console.error(`[${provider.name}] metadata failed: ${e.code || e.response?.status || e.message}`); return { meta: null, cacheMaxAge: 60 }; }
});

builder.defineStreamHandler(async ({ id }) => {
  const parsed = parseId(id); if (!parsed) return { streams: [] };
  const provider = PROVIDERS[parsed.providerId]; if (!provider) return { streams: [] };
  try {
    const streams = await cached(`streams:${parsed.providerId}:${parsed.key}`, STREAM_TTL, () => provider.streams(parsed.key));
    return { streams: (streams || []).slice(0, 20), cacheMaxAge: Math.floor(STREAM_TTL / 1000) };
  } catch (e) { console.error(`[${provider.name}] streams failed: ${e.code || e.response?.status || e.message}`); return { streams: [], cacheMaxAge: 60 }; }
});

serveHTTP(builder.getInterface(), { port: PORT });
console.log(`Hentai Hub v2.1 listening on port ${PORT}`);
console.log(`Manifest: http://127.0.0.1:${PORT}/manifest.json`);
