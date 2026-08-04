import ConnectorSettings from '../models/ConnectorSettings.js';
import { decrypt } from './cryptoService.js';

const CACHE_TTL_MS = 60 * 1000;
let cache = { value: null, expiresAt: 0 };

export function invalidateGoogleBooksKeyCache() {
  cache = { value: null, expiresAt: 0 };
}

export async function getGoogleBooksApiKey() {
  if (cache.expiresAt > Date.now()) return cache.value;

  let key = process.env.GOOGLE_BOOKS_API_KEY || '';
  try {
    const doc = await ConnectorSettings.findOne({ service: 'googleBooks' }).lean();
    if (doc?.enabled && doc?.apiKey) {
      key = decrypt(doc.apiKey) ?? doc.apiKey;
    }
  } catch {
    // MongoDB indisponible → on garde le fallback env
  }

  cache = { value: key, expiresAt: Date.now() + CACHE_TTL_MS };
  return key;
}
