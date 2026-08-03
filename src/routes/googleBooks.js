import express from 'express';
import axios from 'axios';

const router = express.Router();

// Toutes les formes d'apostrophe rencontrées : droite ('), courbes (‘ ’), backtick (`)
const APOSTROPHE_RE = /['‘’`]/g;

function stripAccents(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function authorVariants(name) {
  const norm = s => s.replace(/\s+/g, ' ').trim();
  const variants = new Set();

  variants.add(name);
  // tirets → espaces
  const noHyphen = name.replace(/-/g, ' ');
  variants.add(noHyphen);
  // apostrophes → espace
  const noApos = name.replace(APOSTROPHE_RE, ' ');
  variants.add(noApos);
  // espaces après un point supprimés : "J. K." → "J.K."
  const compactDots = name.replace(/\.\s+/g, '.');
  variants.add(compactDots);
  // points supprimés entièrement : "J.K." → "JK", "J. K." → "J K"
  const noDots = name.replace(/\./g, '');
  variants.add(noDots);
  // compact sans points : "J.K. Rowling" → "JK Rowling"
  variants.add(compactDots.replace(/\./g, ''));
  // combinaisons tirets + apostrophes
  const noHyphenNoApos = noHyphen.replace(APOSTROPHE_RE, ' ');
  variants.add(noHyphenNoApos);
  // combinaisons tirets + points
  variants.add(noHyphen.replace(/\./g, ''));
  // combinaisons apostrophes + points
  variants.add(noApos.replace(/\./g, ''));
  // tirets + apostrophes + points, tout nettoyé
  variants.add(noHyphenNoApos.replace(/\./g, ''));
  // accents retirés (et combiné avec les nettoyages ci-dessus)
  variants.add(stripAccents(name));
  variants.add(stripAccents(noHyphenNoApos.replace(/\./g, '')));

  return [...variants].map(norm).filter(Boolean);
}
const GOOGLE_BOOKS_API_KEY = process.env.GOOGLE_BOOKS_API_KEY || '';

// Cache en mémoire : clé = "params", valeur = { data, expiresAt }
const searchCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCacheKey(title, author, year, startIndex, limit) {
  return `${(title || '').toLowerCase().trim()}|${(author || '').toLowerCase().trim()}|${year || ''}|${startIndex}|${limit}`;
}

/**
 * Recherche titre seul ou ISBN.
 */
function buildQueries(q) {
  const clean = q.trim();

  // ISBN : 10 ou 13 chiffres (éventuellement avec tirets)
  const isbnClean = clean.replace(/[-\s]/g, '');
  if (/^\d{10}$/.test(isbnClean) || /^\d{13}$/.test(isbnClean)) {
    return [`isbn:${isbnClean}`];
  }

  return [clean];
}

/**
 * Recherche combinée "Auteur Titre" sans séparateur.
 * Stratégie : couper après 2 mots (Prénom Nom + Titre),
 * puis après 3 mots (Prénom Nom Composé + Titre), puis brut.
 * Ex : "Virginie Grimaldi D'autres printemps"
 *   → inauthor:"Virginie Grimaldi" intitle:"D'autres printemps"
 */
function buildCombinedQueries(q) {
  const clean = q.trim();

  // ISBN : déléguer à buildQueries qui gère déjà ce cas
  const isbnClean = clean.replace(/[-\s]/g, '');
  if (/^\d{10}$/.test(isbnClean) || /^\d{13}$/.test(isbnClean)) {
    return [`isbn:${isbnClean}`];
  }

  const words = clean.split(/\s+/);
  const queries = [];

  if (words.length >= 3) {
    queries.push(`inauthor:"${words.slice(0, 2).join(' ')}" intitle:"${words.slice(2).join(' ')}"`);
  }
  if (words.length >= 4) {
    queries.push(`inauthor:"${words.slice(0, 3).join(' ')}" intitle:"${words.slice(3).join(' ')}"`);
  }
  // Fallback brut (Google gère très bien les requêtes mixtes auteur+titre)
  queries.push(clean);

  return queries;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Nombre de tentatives + backoff pour absorber les erreurs réseau/timeout/429 transitoires
async function withRetry(fn, { retries = 2, label = '' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      const retryable = !status || status === 429 || status === 503 || err.code === 'ECONNABORTED' || err.code === 'ECONNRESET';
      if (!retryable || attempt === retries) break;

      const retryAfterHeader = err.response?.headers?.['retry-after'];
      const retryAfterMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : null;
      const backoffMs = retryAfterMs || (500 * Math.pow(2, attempt));

      console.warn(`[Books] ${label} échec (${status || err.code || err.message}), retry ${attempt + 1}/${retries} dans ${backoffMs}ms`);
      await sleep(backoffMs);
    }
  }
  throw lastErr;
}

async function fetchFromGoogle(queryStr, limit, startIndex = 0, options = {}) {
  return withRetry(async () => {
    const response = await axios.get(
      'https://www.googleapis.com/books/v1/volumes',
      {
        params: {
          q:          queryStr,
          maxResults: limit,
          startIndex,
          key:        GOOGLE_BOOKS_API_KEY,
          printType:  'books',
          orderBy:    'relevance',
          ...(options.langRestrict && { langRestrict: options.langRestrict }),
        },
        timeout: 8000,
      }
    );
    return {
      items:      response.data.items      || [],
      totalItems: response.data.totalItems || 0,
    };
  }, { label: `Google Books "${queryStr}"` });
}

const toHttps = (url) => url ? url.replace(/^http:\/\//, 'https://') : url;

// Lance plusieurs requêtes Google Books en parallèle et retourne le premier résultat non vide,
// dans l'ordre de priorité des queries (au lieu d'un enchaînement séquentiel bloquant).
async function firstNonEmptyGoogleResult(queries, limit, startIndex, options) {
  const settled = await Promise.allSettled(
    queries.map(q => fetchFromGoogle(q, limit, startIndex, options))
  );
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.status === 'fulfilled' && s.value.items.length > 0) return s.value;
  }
  return { items: [], totalItems: 0 };
}

// ─── Open Library fallback ────────────────────────────────────────────────────

function normalizeOpenLibraryISBN(data, isbn) {
  const cover = data.cover?.large || data.cover?.medium || data.cover?.small || null;
  const year = (data.publish_date || '').match(/\d{4}/)?.[0] || '';
  return {
    id: `ol-isbn-${isbn}`,
    volumeInfo: {
      title:         data.title || '',
      authors:       (data.authors || []).map(a => a.name).filter(Boolean),
      publishedDate: year,
      description:   'Aucune description disponible',
      pageCount:     data.number_of_pages || 0,
      categories:    [],
      imageLinks:    { thumbnail: cover, smallThumbnail: cover },
      language:      'fr',
      previewLink:   `https://openlibrary.org/isbn/${isbn}`,
      infoLink:      `https://openlibrary.org/isbn/${isbn}`,
      seriesInfo:    null,
    },
  };
}

function normalizeOpenLibrarySearch(doc) {
  const coverUrl = doc.cover_i
    ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`
    : null;
  const key = (doc.key || '').replace('/works/', '');
  return {
    id: `ol-${key || Math.random().toString(36).slice(2)}`,
    volumeInfo: {
      title:         doc.title || '',
      authors:       doc.author_name || ['Auteur inconnu'],
      publishedDate: doc.first_publish_year ? String(doc.first_publish_year) : '',
      description:   'Aucune description disponible',
      pageCount:     doc.number_of_pages_median || 0,
      categories:    [],
      imageLinks:    { thumbnail: coverUrl, smallThumbnail: coverUrl },
      language:      'fr',
      previewLink:   `https://openlibrary.org${doc.key || ''}`,
      infoLink:      `https://openlibrary.org${doc.key || ''}`,
      seriesInfo:    null,
    },
  };
}

async function fetchFromOpenLibraryISBN(isbn) {
  return withRetry(async () => {
    const res = await axios.get('https://openlibrary.org/api/books', {
      params: { bibkeys: `ISBN:${isbn}`, format: 'json', jscmd: 'data' },
      timeout: 8000,
    });
    const data = res.data[`ISBN:${isbn}`];
    return data ? normalizeOpenLibraryISBN(data, isbn) : null;
  }, { label: `OpenLibrary ISBN "${isbn}"` });
}

async function fetchFromOpenLibrarySearch(q, limit) {
  return withRetry(async () => {
    const res = await axios.get('https://openlibrary.org/search.json', {
      params: {
        q,
        limit,
        fields: 'key,title,author_name,cover_i,first_publish_year,number_of_pages_median',
      },
      timeout: 8000,
    });
    return (res.data.docs || []).map(normalizeOpenLibrarySearch);
  }, { label: `OpenLibrary search "${q}"` });
}

async function fetchFromOpenLibraryAuthor(author, limit = 40) {
  const variants = authorVariants(author);
  for (const v of variants) {
    try {
      const docs = await withRetry(async () => {
        const res = await axios.get('https://openlibrary.org/search.json', {
          params: {
            author: v,
            language: 'fre',
            limit,
            fields: 'key,title,author_name,cover_i,first_publish_year,number_of_pages_median,language',
          },
          timeout: 8000,
        });
        return res.data.docs || [];
      }, { label: `OpenLibrary author "${v}"` });
      if (docs.length > 0) return docs.map(normalizeOpenLibrarySearch);
    } catch (err) {
      console.warn(`[Books] OpenLibrary author "${v}" échoué après retries:`, err.message);
    }
  }
  return [];
}

function formatPool(items) {
  return items.map(book => {
    const imageLinks = book.volumeInfo.imageLinks || {};
    return {
      id: book.id,
      volumeInfo: {
        title:         book.volumeInfo.title,
        authors:       book.volumeInfo.authors || ['Auteur inconnu'],
        publishedDate: book.volumeInfo.publishedDate,
        description:   book.volumeInfo.description || 'Aucune description disponible',
        pageCount:     book.volumeInfo.pageCount || 0,
        categories:    book.volumeInfo.categories || [],
        imageLinks: {
          thumbnail:      toHttps(imageLinks.thumbnail),
          smallThumbnail: toHttps(imageLinks.smallThumbnail),
        },
        language:    book.volumeInfo.language    || 'fr',
        previewLink: book.volumeInfo.previewLink || '',
        infoLink:    book.volumeInfo.infoLink    || '',
        seriesInfo:  book.volumeInfo.seriesInfo  || null,
      }
    };
  });
}

function extractTomeNumber(volumeInfo) {
  const si = volumeInfo?.seriesInfo;
  if (si?.bookDisplayNumber) {
    const n = parseFloat(si.bookDisplayNumber);
    if (!isNaN(n)) return n;
  }
  if (si?.volumeSeries?.[0]?.orderNumber) return si.volumeSeries[0].orderNumber;
  const title = volumeInfo?.title || '';
  const patterns = [/tome\s*(\d+(?:\.\d+)?)/i, /vol(?:ume)?\.?\s*(\d+(?:\.\d+)?)/i, /#\s*(\d+(?:\.\d+)?)/i, /,\s*t\.?\s*(\d+(?:\.\d+)?)/i, /\bno?\.?\s*(\d+(?:\.\d+)?)/i];
  for (const p of patterns) {
    const m = title.match(p);
    if (m) return parseFloat(m[1]);
  }
  return Infinity;
}

// Mots-clés qui signalent que ce n'est PAS un tome individuel
const SERIES_EXCLUDE_PATTERNS = [
  /coffret/i, /intégrale/i, /integrale/i, /box\s*set/i,
  /analyse\s+de\s+l['']oeuvre/i, /fiche\s+de\s+lecture/i,
  /décrypt/i, /decrypt/i, /guide\s+(de|du|des)/i, /companion/i,
  /encyclop/i, /making\s+of/i, /\bcomics?\b/i,
];

// Recherche des autres tomes d'une série
router.get('/series-tomes', async (req, res) => {
  try {
    const { name, excludeId } = req.query;
    if (!name) return res.status(400).json({ error: 'Nom de série requis' });

    // Tenter plusieurs stratégies de requête, fusionner et dédupliquer
    const queries = [
      `intitle:"${name}" tome`,
      `intitle:"${name}"`,
      name,
    ];

    const seen = new Set();
    let rawItems = [];

    const settled = await Promise.allSettled(queries.map(q => fetchFromGoogle(q, 40, 0)));
    for (const s of settled) {
      if (s.status !== 'fulfilled') continue;
      for (const item of s.value.items) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          rawItems.push(item);
        }
      }
    }

    // Filtrer : exclure le livre actuel, coffrets, analyses, hors-série
    const nameLC = name.toLowerCase();
    const filtered = rawItems.filter(b => {
      if (b.id === excludeId) return false;
      const title = (b.volumeInfo?.title || '').toLowerCase();
      if (!title.includes(nameLC)) return false;
      if (SERIES_EXCLUDE_PATTERNS.some(p => p.test(b.volumeInfo?.title || ''))) return false;
      // Exclure les titres avec ";" (plusieurs volumes dans un coffret)
      if ((b.volumeInfo?.title || '').includes(';')) return false;
      return true;
    });

    // Trier par numéro de tome
    filtered.sort((a, b) => {
      const numA = extractTomeNumber(a.volumeInfo);
      const numB = extractTomeNumber(b.volumeInfo);
      return numA - numB;
    });

    res.json({ results: formatPool(filtered) });
  } catch (err) {
    console.error('[Google Books] Erreur series-tomes:', err.message);
    res.status(500).json({ error: 'Erreur lors de la recherche de la série' });
  }
});

// Recherche de livres via Google Books API
router.get('/search', async (req, res) => {
  try {
    const { q, author, combined, maxResults = 10, startIndex = 0 } = req.query;

    if (!q && !author) {
      return res.status(400).json({ message: 'Un titre ou un auteur est requis' });
    }

    const limit  = Math.min(parseInt(maxResults) || 10, 10);
    const offset = Math.max(parseInt(startIndex)  || 0,  0);

    // Pour auteur seul, la clé de cache ignore l'offset (pool complet mis en cache)
    const authorOnly = !!(author?.trim() && !q?.trim());
    const cacheKey   = authorOnly
      ? getCacheKey(q, author, 'pool', 0, 40)
      : getCacheKey(q, author, '', offset, limit);

    // Retourner le cache si valide
    const cached = searchCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      if (authorOnly) {
        // Pool en cache → paginer et renvoyer le bon slice
        const pool = cached.data.pool;
        return res.json({ results: formatPool(pool.slice(offset, offset + limit)), totalItems: pool.length });
      }
      return res.json(cached.data);
    }

    // Construire les requêtes selon les paramètres fournis
    let queries;
    if (q?.trim() && author?.trim()) {
      // Guillemets pour forcer la recherche de phrase exacte
      queries = [
        `intitle:"${q.trim()}" inauthor:"${author.trim()}"`,
        `${q.trim()} inauthor:"${author.trim()}"`,
        q.trim(),
      ];
    } else if (authorOnly) {
      const variants = authorVariants(author.trim());
      queries = [
        ...variants.map(v => `inauthor:"${v}"`),
        ...variants,
      ];
    } else if (combined === 'true' && q?.trim()) {
      queries = buildCombinedQueries(q);
    } else {
      queries = buildQueries(q);
    }

    let rawItems   = [];
    let totalItems = 0;

    if (authorOnly) {
      const result = await firstNonEmptyGoogleResult(queries, 40, 0, { langRestrict: 'fr' });
      let pool = result.items;
      pool = pool.filter(item =>
        !item.volumeInfo?.language || item.volumeInfo.language === 'fr'
      );
      // Fallback Open Library si Google Books ne trouve rien en français
      if (pool.length === 0) {
        pool = await fetchFromOpenLibraryAuthor(author.trim());
      }
      pool.sort((a, b) => {
        const yearA = parseInt((a.volumeInfo?.publishedDate || '').slice(0, 4)) || 0;
        const yearB = parseInt((b.volumeInfo?.publishedDate || '').slice(0, 4)) || 0;
        return yearB - yearA;
      });
      // Mettre le pool en cache (format spécifique)
      searchCache.set(cacheKey, { data: { pool }, expiresAt: Date.now() + CACHE_TTL_MS });
      rawItems   = pool.slice(offset, offset + limit);
      totalItems = pool.length;
    } else {
      const result = await firstNonEmptyGoogleResult(queries, limit, offset);
      rawItems   = result.items;
      totalItems = result.totalItems;
      // Fallback titre brut si aucun résultat structuré (page 1 seulement)
      if (rawItems.length === 0 && queries.length > 1 && offset === 0 && q?.trim()) {
        const result = await fetchFromGoogle(q.trim(), limit, 0);
        rawItems   = result.items;
        totalItems = result.totalItems;
      }
    }

    // ── Fallback Open Library si Google Books n'a rien trouvé (page 1 seulement) ─
    if (rawItems.length === 0 && offset === 0 && !authorOnly) {
      try {
        const isbnClean = (q || '').trim().replace(/[-\s]/g, '');
        const isISBN = /^\d{10}$/.test(isbnClean) || /^\d{13}$/.test(isbnClean);

        if (isISBN) {
          const olResult = await fetchFromOpenLibraryISBN(isbnClean);
          if (olResult) {
            console.log(`[Books] Open Library fallback ISBN → "${olResult.volumeInfo.title}"`);
            return res.json({ results: [olResult], totalItems: 1 });
          }
        } else if (q?.trim()) {
          const olResults = await fetchFromOpenLibrarySearch(q.trim(), limit);
          if (olResults.length > 0) {
            console.log(`[Books] Open Library fallback → ${olResults.length} résultat(s)`);
            return res.json({ results: olResults, totalItems: olResults.length });
          }
        }
      } catch (olErr) {
        console.warn('[Books] Open Library fallback échoué:', olErr.message);
      }
    }

    const responseData = { results: formatPool(rawItems), totalItems };

    // Mettre en cache (seulement pour les recherches non-auteur, le pool auteur est déjà caché)
    if (!authorOnly) {
      searchCache.set(cacheKey, { data: responseData, expiresAt: Date.now() + CACHE_TTL_MS });
    }

    // Nettoyer les entrées expirées toutes les 100 requêtes
    if (searchCache.size % 100 === 0) {
      const now = Date.now();
      for (const [key, val] of searchCache.entries()) {
        if (val.expiresAt <= now) searchCache.delete(key);
      }
    }

    res.json(responseData);
  } catch (error) {
    console.error(`Erreur lors de la recherche Google Books (q="${req.query.q || ''}", author="${req.query.author || ''}"):`, error.message);

    // Si rate limit (429) ou service indisponible (503), retourner cache expiré si dispo
    if (error.response?.status === 429 || error.response?.status === 503) {
      const limit       = Math.min(parseInt(req.query.maxResults || 10), 10);
      const offset       = Math.max(parseInt(req.query.startIndex) || 0, 0);
      const authorOnlyErr = !!(req.query.author?.trim() && !req.query.q?.trim());
      const cacheKey      = authorOnlyErr
        ? getCacheKey(req.query.q, req.query.author, 'pool', 0, 40)
        : getCacheKey(req.query.q, req.query.author, '', offset, limit);
      const stale = searchCache.get(cacheKey);
      if (stale) {
        if (authorOnlyErr) {
          const pool = stale.data.pool;
          return res.json({ results: formatPool(pool.slice(offset, offset + limit)), totalItems: pool.length });
        }
        return res.json(stale.data);
      }
    }

    res.status(500).json({
      message: 'Erreur lors de la recherche de livres',
      error: error.message,
    });
  }
});

export default router;
