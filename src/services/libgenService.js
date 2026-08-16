import axios from 'axios';
import ConnectorSettings from '../models/ConnectorSettings.js';
import { getProxyConfig, getProxyAgent } from './proxyConfig.js';

// LibGen sert de source de repli quand Anna's Archive est inaccessible (DDoS-Guard) :
// ses pages ne sont protégées par aucun challenge anti-bot, et le téléchargement depuis
// un md5 est déjà géré par annasArchiveService (liens ads.php construits directement).
// Couverture : romans / ouvrages, mais PAS la BD franco-belge ni les comics.

const FALLBACK_URLS = [
  'https://libgen.li',
  'https://libgen.vg',
  'https://libgen.la',
  'https://libgen.bz',
  'https://libgen.gl',
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
};

const KNOWN_EBOOK_EXTS = new Set(['epub', 'mobi', 'pdf', 'cbz', 'cbr', 'azw3', 'fb2', 'djvu']);

export async function getLibgenConfig() {
  const doc = await ConnectorSettings.findOne({ service: 'libgen' }).lean();
  return doc || { service: 'libgen', enabled: false, url: FALLBACK_URLS[0] };
}

export async function saveLibgenConfig({ enabled, url }) {
  return ConnectorSettings.findOneAndUpdate(
    { service: 'libgen' },
    { enabled: !!enabled, url: url?.trim() || FALLBACK_URLS[0] },
    { upsert: true, new: true, runValidators: true }
  );
}

// Même logique de repli proxy que les autres connecteurs sortants.
async function axiosGetWithProxy(url, axiosOptions, label) {
  const proxy = await getProxyConfig();

  const direct = () => axios.get(url, axiosOptions);
  const viaProxy = () => axios.get(url, {
    ...axiosOptions,
    httpsAgent: getProxyAgent(proxy.url),
    proxy: false,
  });

  if (!proxy.enabled) return direct();

  const secondVia = proxy.mode === 'default' ? 'connexion directe' : 'proxy';
  const [first, second] = proxy.mode === 'default' ? [viaProxy, direct] : [direct, viaProxy];
  try {
    return await first();
  } catch (err) {
    console.warn(`[Libgen] ${label} échec (${err.response?.status || err.code || err.message}), tentative via ${secondVia}`);
    const result = await second();
    console.log(`[Libgen] ${label} réussi via ${secondVia}`);
    return result;
  }
}

async function getWorkingUrl(primaryUrl) {
  const candidates = [primaryUrl, ...FALLBACK_URLS.filter(u => u !== primaryUrl)];
  return Promise.any(
    candidates.map(url =>
      axiosGetWithProxy(`${url}/`, {
        headers: HEADERS,
        timeout: 8000,
        validateStatus: s => s < 500,
      }, `ping ${url}`).then(res => {
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        return url;
      })
    )
  ).catch(() => {
    throw new Error('Aucun miroir LibGen joignable');
  });
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(d));
}

function stripTags(str) {
  return decodeEntities(String(str).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/**
 * Parse la table de résultats LibGen. Colonnes observées :
 * 0 titre (+ série, ISBN, badges) · 1 auteur · 2 éditeur · 3 année · 4 langue
 * 5 pages · 6 taille · 7 format · 8 miroirs (contient ads.php?md5=…)
 */
function parseResults(html, baseUrl) {
  const results = [];
  const seen = new Set();

  for (const row of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []) {
    const md5Match = row.match(/ads\.php\?md5=([a-fA-F0-9]{32})/i);
    if (!md5Match) continue;
    const md5 = md5Match[1].toLowerCase();
    if (seen.has(md5)) continue;

    const tds = row.match(/<td[^>]*>[\s\S]*?<\/td>/g) || [];
    if (tds.length < 8) continue;

    // Le titre est le libellé du lien edition.php ; le 1er <a> est la série éventuelle.
    const editionLink = tds[0].match(/href="edition\.php\?id=\d+"[^>]*>([\s\S]*?)<\/a>/);
    let title = stripTags(editionLink ? editionLink[1] : tds[0]);
    // Retirer les suffixes de pagination/format ajoutés par LibGen : "(1/1)", "pb", "hc"…
    title = title.replace(/\s*\(\d+\/\d+\)\s*/g, ' ').replace(/\s+(pb|hc|nov)\s*$/i, '').trim();
    if (!title) continue;

    const author = stripTags(tds[1]).replace(/,\s*$/, '') || null;
    const year = (stripTags(tds[3]).match(/\d{4}/) || [])[0] || null;
    const lang = stripTags(tds[4]) || null;
    const size = stripTags(tds[6]) || null;

    let format = stripTags(tds[7]).toLowerCase() || null;
    if (format && !KNOWN_EBOOK_EXTS.has(format.replace(/[^a-z0-9]/g, ''))) format = null;

    seen.add(md5);
    results.push({
      md5,
      title,
      author,
      cover: null, // absent de la table de résultats LibGen
      format,
      size,
      lang,
      year,
      // Conserve le nom `annaUrl` : le reste du pipeline (UI, notifications) l'attend déjà
      annaUrl: `${baseUrl}/ads.php?md5=${md5}`,
      source: 'libgen',
    });
  }

  return results;
}

/**
 * Recherche sur LibGen. Retourne la même forme que searchOnAnnasArchive()
 * pour être interchangeable dans le pipeline existant.
 */
export async function searchOnLibgen(query) {
  const config = await getLibgenConfig();
  if (!config.enabled) throw new Error('Connecteur LibGen désactivé');

  const baseUrl = await getWorkingUrl((config.url || FALLBACK_URLS[0]).replace(/\/$/, ''));
  const searchUrl = `${baseUrl}/index.php?req=${encodeURIComponent(query)}`;

  const res = await axiosGetWithProxy(searchUrl, {
    headers: HEADERS,
    timeout: 20000,
  }, `search "${query}"`);

  const results = parseResults(typeof res.data === 'string' ? res.data : '', baseUrl);
  return { results, baseUrl };
}

export async function pingLibgen() {
  const config = await getLibgenConfig();
  const baseUrl = await getWorkingUrl((config.url || FALLBACK_URLS[0]).replace(/\/$/, ''));
  return { ok: true, baseUrl };
}
