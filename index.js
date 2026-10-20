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

function canonicalHost(hostname) {
  return String(hostname || '').toLowerCase().replace(/^www\./, '');
}
function sameProviderHost(url, base) {
  try {
    const a = new URL(url);
    const b = new URL(base);
    return canonicalHost(a.hostname) === canonicalHost(b.hostname);
  } catch { return false; }
}
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
  return cached(`html:${url}|ref:${referer || ''}`, CATALOG_TTL, async () => {
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
  const candidates = [];
  const $img = ($card.find('img').first().length ? $card.find('img').first() : $a.find('img').first());
  if ($img.length) {
    for (const key of ['data-src', 'data-lazy-src', 'data-original', 'data-thumb', 'data-poster', 'poster', 'src']) {
      const value = $img.attr(key);
      if (value) candidates.push(value);
    }
    for (const key of ['data-srcset', 'data-lazy-srcset', 'srcset']) {
      const value = $img.attr(key);
      if (value) candidates.push(...value.split(',').map(part => clean(part).split(/\s+/)[0]).filter(Boolean));
    }
  }
  const $source = $card.find('source[srcset], source[src], video[poster]').first();
  for (const key of ['data-src', 'src', 'poster']) {
    const value = $source.attr(key);
    if (value) candidates.push(value);
  }
  if ($source.attr('srcset')) candidates.push(...$source.attr('srcset').split(',').map(part => clean(part).split(/\s+/)[0]).filter(Boolean));
  const $styled = $card.find('[style*="background-image"], [style*="background:"]').first();
  const style = $styled.attr('style') || $card.attr('style') || $a.attr('style') || '';
  const match = style.match(/background(?:-image)?\s*:\s*[^;]*?url\(["']?([^"')]+)["']?\)/i);
  if (match) candidates.push(match[1]);
  for (const candidate of candidates) {
    const resolved = absUrl(candidate, base);
    if (resolved) return resolved;
  }
  return '';
}
function parseStructuredCards($, base) {
  const out = [];
  const seen = new Set();
  $('script[type="application/ld+json"]').each((_, el) => {
    let data;
    try { data = JSON.parse($(el).contents().text() || $(el).text()); } catch { return; }
    const walk = value => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { value.forEach(walk); return; }
      const type = Array.isArray(value['@type']) ? value['@type'].join(' ') : String(value['@type'] || '');
      if (/VideoObject|Movie|TVEpisode|CreativeWork/i.test(type)) {
        const rawUrl = value.url || value['@id'] || value.embedUrl;
        const key = absUrl(typeof rawUrl === 'object' ? (rawUrl.url || rawUrl['@id']) : rawUrl, base);
        const imageValue = Array.isArray(value.image) ? value.image[0] : (value.image || value.thumbnailUrl || value.thumbnail || value.poster);
        const poster = absUrl(typeof imageValue === 'object' ? (imageValue.url || imageValue.contentUrl || imageValue['@id']) : imageValue, base);
        const name = clean(value.name || value.headline);
        const item = { key, name, poster, genres: Array.isArray(value.genre) ? value.genre.map(clean) : value.genre ? [clean(value.genre)] : [], description: clean(value.description) };
        if (key && name && poster && !seen.has(key) && !blocked(item) && !isNoise(key)) {
          try {
            if (sameProviderHost(key, base)) {
              seen.add(key); out.push(item);
            }
          } catch {}
        }
      }
      for (const [key, child] of Object.entries(value)) if (key !== '@context') walk(child);
    };
    walk(data);
  });
  return out;
}

function parseCards(html, base) {
  const $ = cheerio.load(html);
  const out = parseStructuredCards($, base);
  const seen = new Set(out.map(item => item.key));
  const selectors = ['article a[href]', '.video-item a[href]', '.video-card a[href]', '[class*="video-card"] a[href]', '[class*="video-item"] a[href]', '.movie-item a[href]', '[class*="movie-item"] a[href]', '.video a[href]', '.item a[href]', '.thumb a[href]', '.thumb-block a[href]', '.post a[href]', '.result-item a[href]', '.animposx a[href]', '.bs a[href]', '.entry a[href]', '.grid-item a[href]', '.movie a[href]', 'li a[href]', 'a[href]'];
  for (const selector of selectors) {
    $(selector).each((_, el) => {
      const $a = $(el);
      const href = absUrl($a.attr('href'), base);
      if (!href || seen.has(href) || isNoise(href)) return;
      let parsed;
      try { parsed = new URL(href); } catch { return; }
      if (!sameProviderHost(href, base)) return;
      if (/\/(?:page|genre|genres|category|tag|author|search|login|register|contact|about)(?:\/|$)/i.test(parsed.pathname)) return;
      const $closest = $a.closest('article,.video-item,.video-card,[class*=\"video-card\"],[class*=\"video-item\"],.movie-item,[class*=\"movie-item\"],.video,.item,.thumb,.thumb-block,.post,.result-item,.animposx,.bs,.entry,.grid-item,.movie,li');
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
    return [...new Set([
      `${base}/?s=${q}${page > 1 ? `&paged=${page}` : ''}`,
      `${base}/?search=${q}${page > 1 ? `&page=${page}` : ''}`,
      `${base}/search/${q.replace(/%20/g, '+')}/${page > 1 ? `page/${page}/` : ''}`,
      ...(config.searchPaths || []).map(path => `${base}${path.replace('{q}', q).replace('{page}', page)}`),
    ])];
  }
  if (genre) {
    const g = slugify(genre);
    return [...new Set((config.genrePaths || ['/genre/{g}/', '/tag/{g}/', '/category/{g}/']).flatMap(path => {
      const route = `${base}${path.replace('{g}', g)}`;
      return page > 1 ? [pagePath(base, path.replace('{g}', g), page), `${route}${route.includes('?') ? '&' : '?'}page=${page}`, `${route}${route.includes('?') ? '&' : '?'}paged=${page}`] : [route];
    }))];
  }
  return [...new Set((config.listPaths || ['/']).flatMap(path => {
    const route = `${base}${path.startsWith('/') ? path : `/${path}`}`;
    if (page <= 1) return [route];
    const queryPath = `${route}${route.includes('?') ? '&' : '?'}page=${page}`;
    const pagedPath = `${route}${route.includes('?') ? '&' : '?'}paged=${page}`;
    return [pagePath(base, path, page), queryPath, pagedPath];
  }))];
}
async function fetchCatalog(config, args) {
  let lastError;
  let reachedPage = false;
  const tried = [];
  for (const url of candidatePages(config, args)) {
    tried.push(url);
    try {
      const html = await getHtml(url, config.base);
      reachedPage = true;
      // Parse against the requested URL. sameProviderHost also accepts www/non-www redirects.
      const items = parseCards(html, url);
      if (items.length) return items;
    } catch (e) {
      lastError = e;
      // A 404 on one guessed pagination/search route is expected; try other known routes.
    }
  }
  if (!reachedPage && lastError) throw lastError;
  if (!reachedPage) console.warn(`[${config.name}] no candidate page could be fetched: ${tried.join(' | ')}`);
  else console.warn(`[${config.name}] pages fetched but parser found 0 eligible cards: ${tried.join(' | ')}`);
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
function normalizePlayerText(value) {
  return String(value || '')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&').replace(/\\u003d/gi, '=')
    .replace(/\\u003a/gi, ':').replace(/\\u002f/gi, '/')
    .replace(/\\x3a/gi, ':').replace(/\\x2f/gi, '/')
    .replace(/&amp;/gi, '&').replace(/&#038;/g, '&').replace(/&quot;/g, '"');
}

const MEDIA_URL_RE = /\.(?:m3u8|mp4|m4v|mpd|webm)(?:[?#]|$)/i;
function extractMedia(html, base = '') {
  const source = normalizePlayerText(html);
  const urls = new Set();
  const add = (raw) => {
    if (!raw) return;
    let candidate = String(raw).trim().replace(/[),;]+$/, '').replace(/["'\\]+$/, '');
    candidate = candidate.replace(/\\u0026/gi, '&').replace(/&amp;/gi, '&');
    const absolute = absUrl(candidate, base || 'https://invalid.local/');
    if (absolute && MEDIA_URL_RE.test(absolute) && !isNoise(absolute)) urls.add(absolute);
  };

  // Plain and JSON-escaped absolute URLs.
  const absolutePattern = /https?:\\?\/\\?\/[^\s"'<>\\)]+?\.(?:m3u8|mp4|m4v|mpd|webm)(?:\?[^\s"'<>\\)]*)?/gi;
  for (const match of source.matchAll(absolutePattern)) add(match[0]);

  // Common player config forms: file, src, url, hls, and source lists.
  const configPattern = /(?:file|src|url|hls|mp4|video_url|stream_url|playlist|source)\s*["']?\s*[:=]\s*["']([^"']+)["']/gi;
  for (const match of source.matchAll(configPattern)) add(match[1]);

  // HTML video tags and source tags, including relative links.
  if (base) {
    const $ = cheerio.load(source);
    $('video, video source, source, [data-file], [data-hls], [data-mp4]').each((_, el) => {
      const node = $(el);
      for (const key of ['src', 'data-src', 'data-file', 'data-hls', 'data-mp4']) {
        const value = node.attr(key);
        if (value && MEDIA_URL_RE.test(value)) add(value);
      }
    });
  }
  return [...urls];
}

function candidateStreams(html, base) {
  const $ = cheerio.load(normalizePlayerText(html));
  const media = new Set(extractMedia(html, base));
  const embeds = new Set();
  const addEmbed = raw => {
    const src = absUrl(normalizePlayerText(raw), base);
    if (!src || isNoise(src) || /\.(?:jpe?g|png|gif|webp|svg)(?:[?#]|$)/i.test(src)) return;
    try {
      const parsed = new URL(src);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') embeds.add(src);
    } catch {}
  };
  // Some sites expose their player iframe only inside a textarea/input value or escaped embed-code string.
  const rawEmbedText = normalizePlayerText(html)
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;/gi, "'");
  for (const match of rawEmbedText.matchAll(/<iframe\b[^>]*\b(?:src|data-src)\s*=\s*["']([^"']+)["']/gi)) addEmbed(match[1]);
  for (const match of rawEmbedText.matchAll(/(?:embed(?:_url)?|player(?:_url)?|iframe_url)\s*[:=]\s*["'`]([^"'`]+)["'`]/gi)) addEmbed(match[1]);
  $('video source, video, source, [data-file], [data-hls], [data-mp4]').each((_, el) => {
    const node = $(el);
    for (const key of ['src', 'data-src', 'data-file', 'data-hls', 'data-mp4']) {
      const src = absUrl(node.attr(key), base);
      if (src && MEDIA_URL_RE.test(src)) media.add(src);
    }
  });

  // Player iframes are often one or two levels away from the actual manifest.
  $('iframe[src], iframe[data-src], [data-embed], [data-player], [data-video]').each((_, el) => {
    const node = $(el);
    for (const key of ['src', 'data-src', 'data-embed', 'data-player', 'data-video']) {
      const src = absUrl(node.attr(key), base);
      if (!src || isNoise(src) || /^(?:about:|javascript:|data:)/i.test(src)) continue;
      try {
        const parsed = new URL(src);
        if (sameProviderHost(src, base) && /\/(?:category|genre|tag|search|login|register)\//i.test(parsed.pathname)) continue;
      } catch { continue; }
      if (MEDIA_URL_RE.test(src)) media.add(src);
      else embeds.add(src);
    }
  });
  return { media: [...media], embeds: [...embeds] };
}

function streamObject(providerName, url, referer) {
  const parsed = new URL(url);
  const ext = parsed.pathname.toLowerCase();
  const type = ext.endsWith('.m3u8') ? 'HLS' : ext.endsWith('.mpd') ? 'DASH' : ext.endsWith('.webm') ? 'WEBM' : 'MP4';
  let filename = ext.split('/').pop() || `stream.${type.toLowerCase()}`;
  try { filename = decodeURIComponent(filename); } catch { /* Preserve the raw filename if the URL contains invalid escapes. */ }
  return {
    name: providerName,
    title: type,
    url,
    behaviorHints: {
      notWebReady: true,
      filename,
      proxyHeaders: { request: { Referer: referer, 'User-Agent': UA } },
    },
  };
}

async function resolveStreams(providerName, pageUrl) {
  const streams = [];
  const streamUrls = new Set();
  const visited = new Set();
  const external = [];
  const queue = [{ url: pageUrl, referer: pageUrl, depth: 0, html: null }];
  const maxDepth = Number(process.env.EMBED_DEPTH || 3);
  const maxPages = Number(process.env.EMBED_PAGE_LIMIT || 18);

  while (queue.length && visited.size < maxPages) {
    const current = queue.shift();
    if (!current?.url || visited.has(current.url) || current.depth > maxDepth) continue;
    visited.add(current.url);
    try {
      const html = current.html ?? await getHtml(current.url, current.referer);
      const found = candidateStreams(html, current.url);
      for (const mediaUrl of found.media) {
        if (streamUrls.has(mediaUrl)) continue;
        streamUrls.add(mediaUrl);
        try { streams.push(streamObject(providerName, mediaUrl, current.url)); }
        catch { /* Ignore malformed player URLs. */ }
      }
      for (const embedUrl of found.embeds) {
        if (visited.has(embedUrl) || queue.some(item => item.url === embedUrl)) continue;
        if (current.depth < maxDepth) queue.push({ url: embedUrl, referer: current.url, depth: current.depth + 1, html: null });
        else external.push(embedUrl);
      }
      // Keep the final player page as a browser fallback when its media is rendered client-side.
      if (current.url !== pageUrl && !found.media.length && !found.embeds.length) external.push(current.url);
    } catch (e) {
      // If a player host blocks server-side fetching, keep its page as a browser fallback.
      if (current.url !== pageUrl) external.push(current.url);
      console.warn(`[${providerName}] player fetch failed (${current.url}): ${e.code || e.response?.status || e.message}`);
    }
  }

  // Keep a usable browser route even when the source/player blocks server-side extraction.
  if (!streams.length) {
    if (!external.includes(pageUrl)) external.unshift(pageUrl);
    for (const url of [...new Set(external)].slice(0, 4)) {
      streams.push({ name: providerName, title: 'Open player in browser', externalUrl: url });
    }
  }
  console.log(`[${providerName}] stream resolver: ${streams.filter(s => s.url).length} direct, ${streams.filter(s => s.externalUrl).length} browser fallback, ${visited.size} pages checked`);
  return streams;
}

function htmlProvider(config) {
  return {
    ...config,
    async catalog(args) { return fetchCatalog(config, args); },
    async meta(key) {
      const data = await pageMeta(key, config);
      if (!data.poster) {
        const cards = parseCards(await getHtml(key, config.base), key);
        if (cards[0]) data.poster = cards[0].poster;
      }
      return data;
    },
    async streams(key) { return resolveStreams(config.name, key); },
  };
}

const hentaimama = htmlProvider({ id: 'hentaimama', name: 'HentaiMama', base: process.env.HENTAIMAMA_BASE || 'https://hentaimama.io', listPaths: ['/', '/tvshows/'], genrePaths: ['/genre/{g}/', '/genres/{g}/', '/tag/{g}/', '/category/{g}/'] });
const hentaitv = htmlProvider({ id: 'hentaitv', name: 'Hentai.TV', base: process.env.HENTAITV_BASE || 'https://hentai.tv', listPaths: ['/', '/videos/', '/browse/'], genrePaths: ['/genre/{g}/', '/tag/{g}/', '/category/{g}/'] });
const hentaigasm = htmlProvider({ id: 'hentaigasm', name: 'Hentaigasm', base: process.env.HENTAIGASM_BASE || 'https://hentaigasm.com', listPaths: ['/'], genrePaths: ['/genre/{g}/', '/tag/{g}/', '/category/{g}/'] });
const hentaismile = htmlProvider({ id: 'hentaismile', name: 'HentaiSmile', base: process.env.HENTAISMILE_BASE || 'https://www.hentaismile.com', listPaths: ['/latest-updates/', '/'], genrePaths: ['/tags/{g}/', '/tag/{g}/', '/category/{g}/'], searchPaths: ['/search/{q}/'] });
const hentaicity = htmlProvider({ id: 'hentaicity', name: 'HentaiCity', base: process.env.HENTAICITY_BASE || 'https://www.hentaicity.com', listPaths: ['/videos/straight/all-recent.html', '/'], genrePaths: ['/videos/straight/{g}-popular.html', '/genre/{g}/', '/tag/{g}/', '/category/{g}/'], searchPaths: ['/search/{q}/'] });

// Hanime's search endpoint is the service root, not /search.
const HANIME_SEARCH = process.env.HANIME_SEARCH_URL || 'https://search.htv-services.com/';
const HANIME_API = process.env.HANIME_API || 'https://hanime.tv/api/v8/video?id=';
const HANIME_LANDING = process.env.HANIME_LANDING_URL || 'https://hanime.tv/api/v8/landing';
const HANIME_HEADERS = { Referer: 'https://hanime.tv/', Origin: 'https://hanime.tv', Accept: 'application/json' };
const hanimeHtmlConfig = {
  id: 'hanime', name: 'Hanime', base: 'https://hanime.tv',
  listPaths: ['/videos/hentai', '/'],
  genrePaths: ['/tags/{g}', '/genres/{g}/', '/videos/hentai/genre/{g}/'],
  searchPaths: ['/search?query={q}', '/videos/hentai?search={q}'],
};
function normalizeHanimeItems(data, base = 'https://hanime.tv') {
  const result = [];
  const seen = new Set();
  const imageUrl = value => {
    const candidate = Array.isArray(value) ? value[0] : value;
    if (candidate && typeof candidate === 'object') return absUrl(candidate.url || candidate.contentUrl || candidate.src || candidate['@id'], base);
    return absUrl(candidate, base);
  };
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    const rawSlug = value.slug || value.video_slug || value.url || value.link || value['@id'];
    const name = clean(value.name || value.title || value.headline);
    const poster = imageUrl(value.poster_url || value.cover_url || value.thumbnail_url || value.thumbnailUrl || value.poster || value.image || value.thumbnail);
    if (rawSlug && name && poster) {
      let key;
      if (/^https?:\/\//i.test(String(rawSlug))) key = hanimeSlug(rawSlug);
      else if (String(rawSlug).startsWith('/')) key = hanimeSlug(new URL(String(rawSlug), base).href);
      else key = String(rawSlug).replace(/^\/+|\/+$/g, '');
      const item = {
        key,
        name,
        poster,
        description: stripHtml(value.description || value.synopsis || ''),
        genres: (Array.isArray(value.tags) ? value.tags : Array.isArray(value.hentai_tags) ? value.hentai_tags : [])
          .map(tag => clean(typeof tag === 'string' ? tag : (tag.text || tag.name || tag.title))).filter(Boolean).slice(0, 12),
      };
      const dedupeKey = item.key.toLowerCase();
      if (item.key && !seen.has(dedupeKey) && !blocked(item) && !isNoise(item.key)) {
        seen.add(dedupeKey);
        result.push(item);
      }
    }
    for (const [key, child] of Object.entries(value)) if (key !== '@context') walk(child);
  };
  walk(data);
  return result;
}

function hanimeSlug(value) {
  try {
    const u = new URL(String(value));
    const parts = u.pathname.split('/').filter(Boolean);
    const hentaiIndex = parts.indexOf('hentai');
    return parts[hentaiIndex + 1] || parts[parts.length - 1] || String(value);
  } catch { return String(value || '').trim().replace(/^\/+|\/+$/g, ''); }
}
function hanimePageUrl(slug) {
  const value = String(slug || '');
  if (/^https?:\/\//i.test(value)) return value;
  return `https://hanime.tv/videos/hentai/${encodeURIComponent(hanimeSlug(value))}`;
}
const hanime = {
  id: 'hanime', name: 'Hanime', base: 'https://hanime.tv', catalogUrl: HANIME_SEARCH,
  async catalog({ search = '', genre = '', page = 1 }) {
    const payload = { search_text: search, tags: genre ? [genre.toLowerCase()] : [], tags_mode: 'AND', brands: [], blacklist: [], order_by: 'created_at_unix', ordering: 'desc', page: Math.max(0, page - 1) };
    try {
      const { data } = await http.post(HANIME_SEARCH, payload, { headers: { ...HANIME_HEADERS, 'Content-Type': 'application/json;charset=UTF-8' } });
      const hits = typeof data.hits === 'string' ? JSON.parse(data.hits) : (data.hits || []);
      return hits.map(hit => ({ key: hit.slug, name: clean(hit.name), poster: hit.poster_url || hit.cover_url || '', description: stripHtml(hit.description), genres: (hit.tags || []).map(tag => typeof tag === 'string' ? tag : tag.text).filter(Boolean).slice(0, 12) })).filter(item => item.key && item.name && item.poster && !blocked(item));
    } catch (e) {
      console.warn(`[Hanime] search API failed at ${HANIME_SEARCH}: ${e.code || e.response?.status || e.message}; trying alternate catalog sources`);
      if (!search && !genre && page === 1) {
        try {
          const landing = await http.get(HANIME_LANDING, { headers: HANIME_HEADERS });
          const items = normalizeHanimeItems(landing.data);
          if (items.length) {
            console.warn(`[Hanime] fallback landing API returned ${items.length} items`);
            return items;
          }
          console.warn(`[Hanime] landing API returned no recognizable items at ${HANIME_LANDING}`);
        } catch (landingError) {
          console.warn(`[Hanime] landing API failed at ${HANIME_LANDING}: ${landingError.code || landingError.response?.status || landingError.message}`);
        }
      }
      try {
        const items = await fetchCatalog(hanimeHtmlConfig, { search, genre, page });
        const fallback = items.map(item => ({ ...item, key: hanimeSlug(item.key) }));
        if (fallback.length) return fallback.filter(item => item.key && item.name && item.poster && !blocked(item));
      } catch (fallbackError) {
        console.warn(`[Hanime] HTML fallback failed: ${fallbackError.code || fallbackError.response?.status || fallbackError.message}`);
      }
      throw e;
    }
  },
  async video(slug) {
    return cached(`hanime:${slug}`, DETAIL_TTL, async () => (await http.get(`${HANIME_API}${encodeURIComponent(hanimeSlug(slug))}`, { headers: HANIME_HEADERS })).data);
  },
  async meta(slug) {
    try {
      const data = await this.video(slug); const video = data.hentai_video || {}; const franchise = data.hentai_franchise_hentai_videos || [];
      const meta = { name: clean(video.name) || hanimeSlug(slug), poster: video.poster_url || video.cover_url || '', background: video.cover_url || video.poster_url || '', description: stripHtml(video.description), genres: (data.hentai_tags || []).map(tag => tag.text).filter(Boolean).slice(0, 20), episodes: franchise.length > 1 ? franchise.map(item => ({ key: item.slug, title: item.name })) : [] };
      return blocked(meta) ? { ...meta, blocked: true } : meta;
    } catch (e) {
      console.warn(`[Hanime] video API failed for ${hanimeSlug(slug)}: ${e.code || e.response?.status || e.message}; trying page metadata`);
      const data = await pageMeta(hanimePageUrl(slug), hanimeHtmlConfig);
      return blocked(data) ? { ...data, blocked: true } : data;
    }
  },
  async streams(slug) {
    try {
      const data = await this.video(slug); const servers = (data.videos_manifest && data.videos_manifest.servers) || [];
      const streams = servers.flatMap(server => (server.streams || []).map(stream => ({ ...stream, server: server.name }))).filter(stream => stream.url && MEDIA_URL_RE.test(stream.url)).sort((a,b) => (b.height || 0) - (a.height || 0)).map(stream => ({ name: 'Hanime', title: `${stream.height || '?'}p ${stream.server || ''}`.trim(), url: stream.url, behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: 'https://hanime.tv/', 'User-Agent': UA } } } }));
      if (streams.length) return streams;
      return [{ name: 'Hanime', title: 'Open on Hanime', externalUrl: hanimePageUrl(slug) }];
    } catch (e) {
      console.warn(`[Hanime] video streams API failed for ${hanimeSlug(slug)}: ${e.code || e.response?.status || e.message}; trying page resolver`);
      try {
        const streams = await resolveStreams('Hanime', hanimePageUrl(slug));
        return streams.length ? streams : [{ name: 'Hanime', title: 'Open on Hanime', externalUrl: hanimePageUrl(slug) }];
      } catch {
        return [{ name: 'Hanime', title: 'Open on Hanime', externalUrl: hanimePageUrl(slug) }];
      }
    }
  },
};

const PROVIDERS = { hentaimama, hentaitv, hanime, hentaigasm, hentaismile, hentaicity };
const EXTRA = [{ name: 'search', isRequired: false }, { name: 'genre', isRequired: false, options: GENRES, optionsLimit: 1 }, { name: 'skip', isRequired: false }];
const catalogs = [{ type: TYPE, id: 'hn-all', name: 'Hentai Hub - All Providers', extra: EXTRA }, ...Object.values(PROVIDERS).map(p => ({ type: TYPE, id: `hn-${p.id}`, name: p.name, extra: EXTRA }))];
const manifest = { id: 'community.hentai.hub', version: '2.4.1', name: 'Hentai Hub', description: 'Adult anime catalog across multiple providers. Adults 18+ only.', resources: ['catalog','meta','stream'], types: [TYPE], idPrefixes: ['hn:'], catalogs, behaviorHints: { adult: true, configurable: false } };
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
      catch (e) { console.error(`[${provider.name}] catalog failed at ${provider.catalogUrl || provider.base || 'unknown URL'}: ${e.code || e.response?.status || e.message}`); break; }
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

if (require.main === module) {
  serveHTTP(builder.getInterface(), { port: PORT });
  console.log(`Hentai Hub v2.4.1 listening on port ${PORT}`);
  console.log(`Manifest: http://127.0.0.1:${PORT}/manifest.json`);
}

module.exports = { parseCards, parseStructuredCards, candidatePages, fetchCatalog, candidateStreams, extractMedia, normalizeHanimeItems, sameProviderHost, blocked, absUrl };
