// Stremio Hentai Hub - custom type "hentai"
// Providers: HentaiMama, Hentai.TV, Hanime
// Run: npm install && npm start  ->  http://127.0.0.1:7000/manifest.json
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');

const PORT = Number(process.env.PORT) || 7000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Override these via env if a site changes domain
const HM_BASE = process.env.HENTAIMAMA_BASE || 'https://hentaimama.io';
const HTV_BASE = process.env.HENTAITV_BASE || 'https://hentai.tv';
const HANIME_SEARCH = process.env.HANIME_SEARCH_URL || 'https://search.htv-services.com/search';
const HANIME_API = process.env.HANIME_API || 'https://hanime.tv/api/v8/video?id=';

const GENRES = [
  'Uncensored', 'Ahegao', 'Anal', 'BDSM', 'Big Boobs', 'Blow Job', 'Bondage', 'Comedy',
  'Cosplay', 'Creampie', 'Dark Skin', 'Fantasy', 'Futanari', 'Gangbang', 'Glasses', 'Harem',
  'Horror', 'Maid', 'Milf', 'Monster', 'Netorare', 'Office Lady', 'Romance', 'Succubus',
  'Tentacle', 'Threesome', 'Vanilla', 'Yuri'
];

/* ---------------- helpers ---------------- */
const http = axios.create({
  timeout: 15000,
  maxRedirects: 5,
  headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  validateStatus: (s) => s >= 200 && s < 400,
});

const cache = new Map();
async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.val;
  const val = await fn();
  cache.set(key, { val, exp: Date.now() + ttl });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return val;
}
const getHtml = (url, headers = {}) =>
  cached('GET ' + url, 10 * 60e3, async () => (await http.get(url, { headers, responseType: 'text' })).data);

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64url');
const unb64 = (s) => Buffer.from(String(s), 'base64url').toString('utf8');
const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const abs = (u, base) => { try { return u ? new URL(u, base).href : ''; } catch { return ''; } };
const stripHtml = (s) => clean(String(s || '').replace(/<[^>]+>/g, ' '));
const BAD_URL = /\.(jpe?g|png|gif|webp|svg|css|js|ico|woff2?)(\?|$)|wp-json|wp-content|gravatar|google|facebook|twitter|schema\.org|w\.org/i;

function extractMedia(text) {
  const s = String(text).replace(/\\\//g, '/').replace(/&amp;/g, '&');
  const out = new Set();
  for (const m of s.matchAll(/https?:\/\/[^"'\s<>\\)]+?\.(?:m3u8|mp4)(?:\?[^"'\s<>\\)]*)?/gi)) out.add(m[0]);
  return [...out];
}
function extractLinks(text) {
  const s = String(text).replace(/\\\//g, '/').replace(/&amp;/g, '&');
  const out = new Set();
  for (const m of s.matchAll(/https?:\/\/[^"'\s<>\\)]+/g)) if (!BAD_URL.test(m[0])) out.add(m[0]);
  return [...out];
}

// Turn candidate URLs (direct media or embed pages) into Stremio streams
async function toStreams(provName, candidates, referer) {
  const streams = [];
  const seen = new Set();
  const push = (url, label, direct) => {
    if (seen.has(url)) return;
    seen.add(url);
    if (direct) {
      streams.push({
        name: provName,
        title: label,
        url,
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: { request: { Referer: referer, 'User-Agent': UA } },
        },
      });
    } else {
      streams.push({ name: provName, title: label + ' (browser)', externalUrl: url });
    }
  };
  for (const c of candidates.slice(0, 10)) {
    if (/\.(m3u8|mp4)(\?|$)/i.test(c)) { push(c, c.includes('.m3u8') ? 'HLS' : 'MP4', true); continue; }
    try {
      const html = await getHtml(c, { Referer: referer });
      const media = extractMedia(html);
      if (media.length) media.forEach((m) => push(m, m.includes('.m3u8') ? 'HLS' : 'MP4', true));
      else push(c, 'Embed', false);
    } catch { push(c, 'Embed', false); }
  }
  return streams;
}

/* ---------------- generic WordPress provider (HentaiMama, Hentai.TV) ---------------- */
function parseCards($, base) {
  const out = [];
  const seen = new Set();
  const add = ($el, a) => {
    const href = abs(a.attr('href'), base);
    if (!href || seen.has(href) || href.replace(/\/$/, '') === base) return;
    if (/\/(page|genre|category|tag|author|wp-)\b/.test(href)) return;
    const img = $el.find('img').first();
    const poster = abs(img.attr('data-src') || img.attr('data-lazy-src') || img.attr('data-original') || img.attr('src') || '', base);
    const title = clean($el.find('.title, .tt, .entry-title, h2, h3, h4').first().text()) || clean(a.attr('title')) || clean(img.attr('alt'));
    if (!title || !poster) return;
    seen.add(href);
    out.push({ key: href, name: title, poster });
  };
  $('article, .item, .result-item, .post, .animposx, .bs').each((_, el) => {
    const $el = $(el);
    const a = $el.find('a[href]').first();
    if (a.length) add($el, a);
  });
  if (!out.length) {
    $('a[href]').each((_, el) => {
      const a = $(el);
      if (a.find('img').length) add(a, a);
    });
  }
  return out;
}

function wpProvider({ id, name, base, listPath, genrePath, episodeSel, singleIfMatch }) {
  return {
    id, name,
    async catalog({ search, genre, page }) {
      let url;
      if (search) url = `${base}/?s=${encodeURIComponent(search)}${page > 1 ? `&paged=${page}` : ''}`;
      else if (genre) url = `${base}/${genrePath}/${slugify(genre)}/${page > 1 ? `page/${page}/` : ''}`;
      else url = `${base}${listPath}${page > 1 ? `page/${page}/` : ''}`;
      const $ = cheerio.load(await getHtml(url));
      return parseCards($, base);
    },
    async meta(key) {
      const $ = cheerio.load(await getHtml(key));
      const meta = {
        name: clean($('h1').first().text()) || clean($('meta[property="og:title"]').attr('content')),
        poster: $('meta[property="og:image"]').attr('content') || '',
        description: clean($('meta[property="og:description"]').attr('content')) ||
          clean($('.wp-content p, .entry-content p, .description p').first().text()),
        genres: $('.sgeneros a, .genres a, a[rel="tag"], .genre a').map((_, e) => clean($(e).text())).get().filter(Boolean).slice(0, 12),
        episodes: [],
      };
      if (!singleIfMatch.test(key)) {
        const seen = new Set();
        $(episodeSel).each((_, e) => {
          const a = $(e).is('a') ? $(e) : $(e).find('a[href]').first();
          const href = abs(a.attr('href'), base);
          if (!href || seen.has(href)) return;
          seen.add(href);
          meta.episodes.push({ key: href, title: clean(a.text()) || clean(a.attr('title')) });
        });
        const num = (e) => { const m = (e.key + ' ' + e.title).match(/episode[-\s]*(\d+)/i); return m ? Number(m[1]) : 0; };
        meta.episodes.sort((a, b) => num(a) - num(b));
      }
      return meta;
    },
    async streams(key) {
      const html = await getHtml(key);
      const $ = cheerio.load(html);
      const candidates = new Set();
      // DooPlay (HentaiMama) ajax players
      const opts = $('#playeroptionsul li[data-post]').toArray();
      for (const li of opts) {
        try {
          const r = await http.post(
            `${base}/wp-admin/admin-ajax.php`,
            new URLSearchParams({
              action: 'doo_player_ajax',
              post: $(li).attr('data-post'),
              nume: $(li).attr('data-nume') || '1',
              type: $(li).attr('data-type') || 'tv',
            }).toString(),
            { headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: key, 'Content-Type': 'application/x-www-form-urlencoded' } }
          );
          extractLinks(typeof r.data === 'string' ? r.data : JSON.stringify(r.data)).forEach((u) => candidates.add(u));
        } catch { /* skip option */ }
      }
      $('iframe').each((_, e) => {
        const src = abs($(e).attr('src') || $(e).attr('data-src') || $(e).attr('data-lazy-src'), key);
        if (src && !BAD_URL.test(src)) candidates.add(src);
      });
      $('video source, video').each((_, e) => { const s = abs($(e).attr('src'), key); if (s) candidates.add(s); });
      extractMedia(html).forEach((u) => candidates.add(u));
      return toStreams(name, [...candidates], key);
    },
  };
}

const hentaimama = wpProvider({
  id: 'hentaimama', name: 'HentaiMama', base: HM_BASE,
  listPath: '/tvshows/', genrePath: 'genre',
  episodeSel: '#episodes a[href*="/episodes/"], .episodios a[href*="/episodes/"], .episodiotitle a, a[href*="/episodes/"]',
  singleIfMatch: /\/episodes\//,
});

const hentaitv = wpProvider({
  id: 'hentaitv', name: 'Hentai.TV', base: HTV_BASE,
  listPath: '/', genrePath: 'genre',
  episodeSel: 'a[href*="/hentai/"][href*="episode"]',
  singleIfMatch: /\/hentai\//,
});

/* ---------------- Hanime (JSON API) ---------------- */
const HANIME_HEADERS = { Referer: 'https://hanime.tv/', Origin: 'https://hanime.tv', Accept: 'application/json' };
const hanime = {
  id: 'hanime', name: 'Hanime',
  async catalog({ search, genre, page }) {
    const body = {
      search_text: search || '',
      tags: genre ? [genre.toLowerCase()] : [],
      tags_mode: 'AND', brands: [], blacklist: [],
      order_by: 'created_at_unix', ordering: 'desc',
      page: Math.max(0, page - 1),
    };
    const { data } = await http.post(HANIME_SEARCH, body, { headers: { ...HANIME_HEADERS, 'Content-Type': 'application/json' } });
    const hits = typeof data.hits === 'string' ? JSON.parse(data.hits) : data.hits || [];
    return hits.map((h) => ({
      key: h.slug, name: h.name, poster: h.poster_url || h.cover_url || '',
      description: stripHtml(h.description), genres: (h.tags || []).slice(0, 8),
    }));
  },
  async video(slug) {
    return cached('HAN ' + slug, 10 * 60e3, async () => (await http.get(HANIME_API + encodeURIComponent(slug), { headers: HANIME_HEADERS })).data);
  },
  async meta(slug) {
    const d = await this.video(slug);
    const v = d.hentai_video || {};
    const franchise = d.hentai_franchise_hentai_videos || [];
    return {
      name: v.name || slug,
      poster: v.poster_url || v.cover_url || '',
      background: v.cover_url || '',
      description: stripHtml(v.description),
      genres: (d.hentai_tags || []).map((t) => t.text).filter(Boolean).slice(0, 12),
      episodes: franchise.length > 1 ? franchise.map((e) => ({ key: e.slug, title: e.name })) : [],
    };
  },
  async streams(slug) {
    const d = await this.video(slug);
    const servers = (d.videos_manifest && d.videos_manifest.servers) || [];
    const list = servers.flatMap((s) => (s.streams || []).map((st) => ({ ...st, server: s.name })))
      .filter((st) => st.url)
      .sort((a, b) => (b.height || 0) - (a.height || 0));
    return list.map((st) => ({
      name: 'Hanime',
      title: `${st.height || '?'}p ${st.server || ''}`.trim(),
      url: st.url,
      behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: 'https://hanime.tv/', 'User-Agent': UA } } },
    }));
  },
};

const PROVIDERS = { hentaimama, hentaitv, hanime };

/* ---------------- manifest ---------------- */
const extra = [{ name: 'search' }, { name: 'genre', options: GENRES }, { name: 'skip' }];
const manifest = {
  id: 'community.hentai.hub',
  version: '1.0.0',
  name: 'Hentai Hub',
  description: 'Hentai catalogs & streams: HentaiMama, Hentai.TV, Hanime. Adults only (18+).',
  logo: 'https://i.imgur.com/placeholder.png',
  resources: ['catalog', 'meta', 'stream'],
  types: ['hentai'],
  idPrefixes: ['hn:'],
  catalogs: [
    { type: 'hentai', id: 'hn-all', name: 'Hentai Hub - All', extra },
    { type: 'hentai', id: 'hn-hentaimama', name: 'HentaiMama', extra },
    { type: 'hentai', id: 'hn-hentaitv', name: 'Hentai.TV', extra },
    { type: 'hentai', id: 'hn-hanime', name: 'Hanime', extra },
  ],
  behaviorHints: { adult: true, configurable: false },
};
// logo placeholder is optional; remove if you don't have one
delete manifest.logo;

const builder = new addonBuilder(manifest);

/* ---------------- handlers ---------------- */
const firstPageLen = new Map();
function pageFor(catKey, skip) {
  if (!skip) return 1;
  const len = firstPageLen.get(catKey) || 20;
  return Math.floor(skip / len) + 1;
}
const mkId = (prov, key) => `hn:${prov}:${b64(key)}`;
const parseId = (id) => {
  const [, prov, enc] = id.split(':');
  return { prov, key: unb64(enc) };
};

builder.defineCatalogHandler(async ({ id, extra: ex = {} }) => {
  const search = ex.search || '';
  const genre = ex.genre || '';
  const skip = Number(ex.skip) || 0;
  const catKey = `${id}|${search}|${genre}`;
  const page = pageFor(catKey, skip);
  const selected = id === 'hn-all' ? Object.values(PROVIDERS) : [PROVIDERS[id.replace('hn-', '')]].filter(Boolean);

  const results = await Promise.allSettled(selected.map((p) => p.catalog({ search, genre, page })));
  const lists = results.map((r, i) => {
    if (r.status === 'rejected') console.error(`[${selected[i].id}] catalog error:`, r.reason && r.reason.message);
    return r.status === 'fulfilled' ? r.value.map((it) => ({ ...it, prov: selected[i].id })) : [];
  });

  // interleave providers
  const merged = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) lists.forEach((l) => l[i] && merged.push(l[i]));
  if (page === 1 && merged.length) firstPageLen.set(catKey, merged.length);

  const metas = merged.map((it) => ({
    id: mkId(it.prov, it.key),
    type: 'hentai',
    name: it.name,
    poster: it.poster,
    posterShape: 'poster',
    description: it.description,
    genres: it.genres,
  }));
  return { metas, cacheMaxAge: 600 };
});

builder.defineMetaHandler(async ({ id }) => {
  const { prov, key } = parseId(id);
  const p = PROVIDERS[prov];
  if (!p) return { meta: null };
  const m = await p.meta(key);
  const base = new Date('2000-01-01T00:00:00.000Z');
  const eps = m.episodes && m.episodes.length ? m.episodes : [{ key, title: m.name }];
  const videos = eps.map((e, i) => ({
    id: mkId(prov, e.key),
    title: e.title || `Episode ${i + 1}`,
    season: 1,
    episode: i + 1,
    released: new Date(base.getTime() + i * 86400000).toISOString(),
  }));
  return {
    meta: {
      id, type: 'hentai', name: m.name, poster: m.poster, background: m.background || m.poster,
      description: m.description, genres: m.genres, videos,
    },
    cacheMaxAge: 3600,
  };
});

builder.defineStreamHandler(async ({ id }) => {
  const { prov, key } = parseId(id);
  const p = PROVIDERS[prov];
  if (!p) return { streams: [] };
  try {
    return { streams: await p.streams(key), cacheMaxAge: 300 };
  } catch (e) {
    console.error(`[${prov}] stream error:`, e.message);
    return { streams: [] };
  }
});

serveHTTP(builder.getInterface(), { port: PORT });
console.log(`Hentai Hub: http://127.0.0.1:${PORT}/manifest.json`);
