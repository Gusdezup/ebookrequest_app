import ConnectorSettings from '../models/ConnectorSettings.js';
import { decrypt } from './cryptoService.js';
import { HttpsProxyAgent } from 'https-proxy-agent';

const CACHE_TTL_MS = 60 * 1000;
let cache = { value: null, expiresAt: 0 };

export function invalidateProxyConfigCache() {
  cache = { value: null, expiresAt: 0 };
}

function buildProxyUrl(doc) {
  if (!doc?.url) return '';
  try {
    const u = new URL(doc.url);
    if (doc.username) {
      u.username = doc.username;
      u.password = doc.password ? (decrypt(doc.password) ?? doc.password) : '';
    }
    return u.toString();
  } catch {
    return '';
  }
}

// mode: 'default' (proxy utilisé en priorité, repli direct si échec)
//    ou 'fallback' (connexion directe en priorité, proxy utilisé si échec)
export async function getProxyConfig() {
  if (cache.expiresAt > Date.now()) return cache.value;

  let config = { enabled: false, url: '', mode: 'fallback' };
  try {
    const doc = await ConnectorSettings.findOne({ service: 'proxy' }).lean();
    if (doc?.enabled && doc?.url) {
      config = {
        enabled: true,
        url: buildProxyUrl(doc),
        mode: doc.provider === 'default' ? 'default' : 'fallback',
      };
    }
  } catch {
    // MongoDB indisponible → pas de proxy
  }

  cache = { value: config, expiresAt: Date.now() + CACHE_TTL_MS };
  return config;
}

export function getProxyAgent(proxyUrl) {
  return new HttpsProxyAgent(proxyUrl);
}
