import Bestseller from '../models/Bestseller.js';
import TrendingCache from '../models/TrendingCache.js';
import ConnectorSettings from '../models/ConnectorSettings.js';
import { findBestBookMatch } from './bookSearchService.js';

// Cache pour les livres tendance par catégorie
let cachedBooksByCategory = {};
let lastFetchTimeByCategory = {}; // Timestamp par catégorie
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 heures en millisecondes

// (patch perf) Réglage admin pour activer/désactiver le préchargement des 7
// catégories au démarrage du serveur (voir index.js). Activé par défaut
// (`!== false`) pour ne rien changer au comportement existant tant que
// personne n'y touche explicitement.
export async function isTrendingPreloadEnabled() {
  try {
    const doc = await ConnectorSettings.findOne({ service: 'trending' }).lean();
    return doc?.preloadOnStartup !== false;
  } catch (err) {
    console.warn('[Trending] Lecture réglage preloadOnStartup échouée, préchargement activé par défaut:', err.message);
    return true;
  }
}

// Définition des catégories disponibles
export const BOOK_CATEGORIES = {
  ALL: 'all',
  THRILLER: 'thriller',
  ROMANCE: 'romance',
  SF: 'sf',
  BD: 'bd',
  FANTASY: 'fantasy',
  LITERARY: 'literary'
};

// Récupère les livres tendance avec cache de 24h (par catégorie)
export async function getTrendingBooks(category = BOOK_CATEGORIES.ALL) {
  // Vérifier si le cache est encore valide pour cette catégorie spécifique
  const now = Date.now();
  const categoryLastFetch = lastFetchTimeByCategory[category];

  if (cachedBooksByCategory[category] && categoryLastFetch && (now - categoryLastFetch) < CACHE_DURATION) {
    const remainingTime = Math.round((CACHE_DURATION - (now - categoryLastFetch)) / 1000 / 60 / 60);
    console.log(`📦 Utilisation du cache mémoire pour "${category}" (rafraîchissement dans ${remainingTime}h)`);
    return cachedBooksByCategory[category];
  }

  // (patch perf) Cache mémoire absent (redémarrage du conteneur, le cas le plus
  // fréquent) : avant de re-taper Google Books ~10 fois pour cette catégorie,
  // vérifier si un cache encore valide existe en base — persistant, lui, à
  // travers les redémarrages.
  try {
    const persisted = await TrendingCache.findOne({ category }).lean();
    if (persisted && (now - new Date(persisted.fetchedAt).getTime()) < CACHE_DURATION) {
      const remainingTime = Math.round((CACHE_DURATION - (now - new Date(persisted.fetchedAt).getTime())) / 1000 / 60 / 60);
      console.log(`💾 Utilisation du cache persistant pour "${category}" (rafraîchissement dans ${remainingTime}h) — pas d'appel Google Books`);
      cachedBooksByCategory[category] = persisted.books;
      lastFetchTimeByCategory[category] = new Date(persisted.fetchedAt).getTime();
      return persisted.books;
    }
  } catch (err) {
    console.warn(`[TrendingCache] Lecture cache persistant échouée pour "${category}":`, err.message);
  }

  // Cache (mémoire et persistant) expiré ou inexistant, récupérer de nouvelles données
  console.log(`🔄 Récupération de nouveaux livres pour la catégorie "${category}"...`);
  const books = await fetchTrendingBooks(category);

  // Mettre à jour le cache mémoire pour cette catégorie spécifique
  cachedBooksByCategory[category] = books;
  lastFetchTimeByCategory[category] = now;

  // (patch) Ne persister que si on a vraiment trouvé quelque chose. Un résultat
  // vide est presque toujours un échec transitoire (quota épuisé, service down)
  // et pas "il n'y a vraiment aucun livre tendance" — le figer pour 24h en base
  // transformerait un pépin passager en panne d'un jour entier pour les
  // utilisateurs. On retente au prochain appel plutôt que de graver l'échec.
  if (books.length > 0) {
    try {
      await TrendingCache.updateOne(
        { category },
        { $set: { books, fetchedAt: new Date(now) } },
        { upsert: true }
      );
    } catch (err) {
      console.warn(`[TrendingCache] Écriture cache persistant échouée pour "${category}":`, err.message);
    }
  }

  return books;
}

// Fonction interne pour récupérer les livres (appelée seulement quand le cache expire)
async function fetchTrendingBooks(category = BOOK_CATEGORIES.ALL) {
  try {
    console.log(`🔍 Récupération des bestsellers pour "${category}"...`);

    // Récupérer les bestsellers depuis MongoDB
    const filter = { active: true };
    if (category !== BOOK_CATEGORIES.ALL) {
      filter.category = category;
    }

    const bestsellers = await Bestseller.find(filter)
      .sort({ order: 1, createdAt: -1 })
      .limit(10);

    console.log(`📚 ${bestsellers.length} livres à chercher...`);

    // Enrichir les bestsellers séquentiellement pour éviter le rate-limit Google Books
    const frenchBooks = [];
    for (const bestseller of bestsellers) {
      const { title, author } = bestseller;
      console.log(`🔎 Recherche: ${title} ${author ? `par ${author}` : ''}`);
      const googleData = await searchGoogleBooks(title, author);
      if (!googleData) {
        console.log(`⚠️  Non trouvé: ${title}`);
      } else {
        console.log(`✅ Trouvé: ${googleData.title}`);
        frenchBooks.push({
          id: googleData.id,
          title: googleData.title,
          author: googleData.author || author || 'Auteur inconnu',
          thumbnail: googleData.thumbnail,
          description: googleData.description || 'Aucune description disponible.',
          pageCount: googleData.pageCount || 0,
          link: googleData.link || `https://www.google.com/search?q=${encodeURIComponent(title)}`,
          trending_rank: frenchBooks.length + 1,
        });
      }
      // Délai entre chaque appel pour respecter le quota Google Books
      await sleep(300);
    }

    console.log(`✅ ${frenchBooks.length} livres récupérés pour "${category}"`);
    return frenchBooks;

  } catch (error) {
    console.error('Erreur lors de la récupération des bestsellers:', error);
    throw new Error('Impossible de récupérer les bestsellers');
  }
}

// Pré-charge le cache au démarrage du serveur (appelé depuis index.js)
export async function initializeTrendingBooksCache() {
  try {
    console.log('🚀 Initialisation du cache des livres tendance...');
    // Pré-charger les catégories séquentiellement pour éviter le rate-limit Google Books
    const allCategories = Object.values(BOOK_CATEGORIES);
    for (const cat of allCategories) {
      await getTrendingBooks(cat).catch(() => {});
      await sleep(500);
    }
    console.log('✅ Cache des livres tendance initialisé pour toutes les catégories');
  } catch (error) {
    console.error('❌ Erreur lors de l\'initialisation du cache:', error);
  }
}

// Fonction pour vider le cache (appelée quand on modifie les bestsellers)
export function clearTrendingBooksCache() {
  cachedBooksByCategory = {};
  lastFetchTimeByCategory = {};
  // Vidage du cache persistant en base — sinon un redémarrage juste après
  // cette modif resservirait encore les anciennes données depuis Mongo.
  TrendingCache.deleteMany({}).catch(err =>
    console.warn('[TrendingCache] Vidage cache persistant échoué:', err.message));
  console.log('🗑️  Cache des livres tendance vidé (mémoire + persistant)');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function searchGoogleBooks(title, author) {
  const match = await findBestBookMatch({
    title,
    author: author && author !== 'Auteur inconnu' ? author : '',
  });
  if (!match) return null;
  return {
    id: match.id,
    title: match.title || null,
    author: match.author,
    thumbnail: match.thumbnail,
    description: match.description,
    pageCount: match.pageCount,
    link: match.link,
    language: match.language,
  };
}