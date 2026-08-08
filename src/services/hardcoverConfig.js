import ConnectorSettings from '../models/ConnectorSettings.js';
import { decrypt } from './cryptoService.js';

const CACHE_TTL_MS = 60 * 1000;
let cache = { value: null, expiresAt: 0 };

export function invalidateHardcoverKeyCache() {
  cache = { value: null, expiresAt: 0 };
}

// Retourne la clé API si le service Hardcover est activé, sinon null (pas de fallback env :
// Hardcover est un service optionnel, contrairement à Google Books).
export async function getHardcoverApiKey() {
  if (cache.expiresAt > Date.now()) return cache.value;

  let key = null;
  try {
    const doc = await ConnectorSettings.findOne({ service: 'hardcover' }).lean();
    if (doc?.enabled && doc?.apiKey) {
      key = decrypt(doc.apiKey) ?? doc.apiKey;
    }
  } catch {
    // MongoDB indisponible → service considéré indisponible
  }

  cache = { value: key, expiresAt: Date.now() + CACHE_TTL_MS };
  return key;
}

// L'API Hardcover est limitée à 60 requêtes/minute (cf. docs.hardcover.app/api/getting-started).
// Hardcover n'étant qu'un fallback, on préfère renoncer silencieusement au-delà du quota
// plutôt que de mettre en file d'attente (ça retarderait la réponse de recherche).
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60 * 1000;
let rateWindowStart = Date.now();
let rateCount = 0;

export function takeHardcoverQuota() {
  const now = Date.now();
  if (now - rateWindowStart >= RATE_WINDOW_MS) {
    rateWindowStart = now;
    rateCount = 0;
  }
  if (rateCount >= RATE_LIMIT) return false;
  rateCount++;
  return true;
}

// Etat du quota courant, pour affichage (ex. carte Santé des services).
export function getHardcoverQuotaStatus() {
  const now = Date.now();
  const windowActive = now - rateWindowStart < RATE_WINDOW_MS;
  return {
    used: windowActive ? rateCount : 0,
    limit: RATE_LIMIT,
  };
}
