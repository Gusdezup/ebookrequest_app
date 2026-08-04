import ConnectorSettings from '../models/ConnectorSettings.js';

const DEFAULT_RSS_URL = 'https://predb.me/?cats=books-ebooks&rss=1';
const CACHE_TTL_MS = 60 * 1000;
let cache = { value: null, expiresAt: 0 };

export function invalidateRSSUrlCache() {
  cache = { value: null, expiresAt: 0 };
}

export async function getRSSFeedUrl() {
  if (cache.expiresAt > Date.now()) return cache.value;

  let url = process.env.RSS_FEED_URL || DEFAULT_RSS_URL;
  try {
    const doc = await ConnectorSettings.findOne({ service: 'rss' }).lean();
    if (doc?.enabled && doc?.url) url = doc.url;
  } catch {
    // MongoDB indisponible → on garde le fallback env
  }

  cache = { value: url, expiresAt: Date.now() + CACHE_TTL_MS };
  return url;
}
