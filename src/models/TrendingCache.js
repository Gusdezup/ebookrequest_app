import mongoose from 'mongoose';

// (patch perf) Cache persistant pour les livres tendance par catégorie.
// Complète le cache en mémoire de trendingBooksService.js, qui lui est perdu
// à chaque redémarrage du conteneur — forçant sinon un re-fetch complet de
// TOUTES les catégories (jusqu'à ~70 requêtes Google Books) à chaque restart,
// même si le cache avait été rafraîchi il y a 5 minutes.
const trendingCacheSchema = new mongoose.Schema({
  category: {
    type: String,
    required: true,
    unique: true,
  },
  books: {
    type: mongoose.Schema.Types.Mixed,
    default: [],
  },
  fetchedAt: {
    type: Date,
    default: Date.now,
  },
});

export default mongoose.models.TrendingCache ||
  mongoose.model('TrendingCache', trendingCacheSchema);
