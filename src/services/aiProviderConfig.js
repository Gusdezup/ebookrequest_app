import ConnectorSettings from '../models/ConnectorSettings.js';
import { decrypt } from './cryptoService.js';

const CACHE_TTL_MS = 60 * 1000;
let cache = { value: null, expiresAt: 0 };

export function invalidateAIProviderConfigCache() {
  cache = { value: null, expiresAt: 0 };
}

// Résout la config effective : DB (si activée) sinon variables d'environnement.
export async function getAIProviderConfig() {
  if (cache.expiresAt > Date.now()) return cache.value;

  const envConfig = {
    provider: process.env.AI_PROVIDER || 'openai',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    claudeModel: process.env.CLAUDE_MODEL || 'claude-opus-4-5',
    ollamaUrl: process.env.OLLAMA_URL || '',
    ollamaModel: process.env.OLLAMA_MODEL || '',
  };

  let config = envConfig;
  try {
    const doc = await ConnectorSettings.findOne({ service: 'aiProvider' }).lean();
    if (doc?.enabled && doc?.provider) {
      const apiKey = doc.apiKey ? (decrypt(doc.apiKey) ?? doc.apiKey) : '';
      config = {
        provider: doc.provider,
        openaiApiKey: doc.provider === 'openai' ? apiKey : envConfig.openaiApiKey,
        openaiModel: doc.provider === 'openai' ? (doc.model || envConfig.openaiModel) : envConfig.openaiModel,
        anthropicApiKey: doc.provider === 'claude' ? apiKey : envConfig.anthropicApiKey,
        claudeModel: doc.provider === 'claude' ? (doc.model || envConfig.claudeModel) : envConfig.claudeModel,
        ollamaUrl: doc.provider === 'ollama' ? (doc.url || envConfig.ollamaUrl) : envConfig.ollamaUrl,
        ollamaModel: doc.provider === 'ollama' ? (doc.model || envConfig.ollamaModel) : envConfig.ollamaModel,
      };
    }
  } catch {
    // MongoDB indisponible → on garde le fallback env
  }

  cache = { value: config, expiresAt: Date.now() + CACHE_TTL_MS };
  return config;
}
