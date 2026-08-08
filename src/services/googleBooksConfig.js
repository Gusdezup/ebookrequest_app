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

// Le toggle "enabled" sert à la fois à activer une clé DB personnalisée et à couper
// entièrement Google Books en tant que source de recherche. Par défaut (aucun document
// en base, installations existantes basées sur la seule variable d'env) le service reste
// actif pour ne rien casser ; il ne devient inactif que si un admin décoche explicitement
// le toggle dans Réglages.
export async function isGoogleBooksSearchEnabled() {
  try {
    const doc = await ConnectorSettings.findOne({ service: 'googleBooks' }).lean();
    if (!doc) return true;
    return doc.enabled !== false;
  } catch {
    return true;
  }
}
