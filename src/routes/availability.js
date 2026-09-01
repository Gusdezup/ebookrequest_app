import express from 'express';
import { checkBookAvailability } from '../services/rssService.js';
import { quickSearchOnValentine } from '../services/valentineService.js';
import { searchOnAnnasArchive } from '../services/annasArchiveService.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

// Reprend la meme logique que isPublishedInFuture cote frontend
// (UserForm.jsx) : gere les formats "AAAA", "AAAA-MM" et "AAAA-MM-JJ".
function isDateInFuture(dateStr) {
  if (!dateStr) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const parts = String(dateStr).split('-');
  let d;
  if (parts.length === 1) d = new Date(parseInt(parts[0], 10), 0, 1);
  else if (parts.length === 2) d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, 1);
  else d = new Date(dateStr);
  return !isNaN(d.getTime()) && d > today;
}

router.post('/check', requireAuth, async (req, res) => {
  try {
    const { title, author, publishedDate } = req.body;

    if (!title || !author) {
      return res.status(400).json({
        success: false,
        message: 'Le titre et l\'auteur sont requis'
      });
    }

    // Livre pas encore sorti (patch) : inutile, voire contre-productif, de
    // solliciter Valentine/Anna's Archive pour un livre qui n'existe pas
    // encore officiellement — on economise ces requetes.
    if (publishedDate && isDateInFuture(publishedDate)) {
      return res.json({
        success: true,
        available: false,
        confidence: 'low',
        message: 'Ce livre n\'est pas encore sorti — aucune vérification effectuée sur Valentine ou Anna\'s Archive.',
        sources: [],
        notYetReleased: true,
      });
    }

    // Lancer les 3 sources en parallèle
    // NB (patch) : quickSearchOnValentine (pas searchOnValentine) — evite la
    // boucle d'enrichissement couverture/taille par resultat (jitter 0.8-2.2s
    // CHACUN), qui faisait regulierement depasser le timeout de 5s ci-dessous
    // meme quand le livre etait bien trouve sur Valentine. Les metadonnees
    // affichees a l'utilisateur viennent de Google Books/Hardcover de toute
    // facon, cette verification n'a besoin que d'un oui/non rapide.
    const [predbRssResult, valentineResult, annasResult] = await Promise.allSettled([
      checkBookAvailability(title, author),
      withTimeout(quickSearchOnValentine(title, author), 5000),
      withTimeout(searchOnAnnasArchive(title), 5000),
    ]);

    const predb = predbRssResult.status === 'fulfilled'
      ? predbRssResult.value
      : { available: false, confidence: 'unknown', message: 'Impossible de vérifier la disponibilité pour le moment', score: 0 };

    // matchType 'title' = titre confirme sur Valentine (signal fort).
    // matchType 'author' = seulement l'auteur trouve, en repli (signal plus
    // faible : ne garantit pas que CE livre precis y soit) — voir
    // quickSearchOnValentine dans valentineService.js.
    const valentineData = valentineResult.status === 'fulfilled' ? valentineResult.value : null;
    const valentineFound = !!valentineData?.results?.length;
    const valentineMatchType = valentineData?.matchType || null;

    const annasFound = annasResult.status === 'fulfilled'
      && Array.isArray(annasResult.value?.results)
      && annasResult.value.results.length > 0;

    const connectorFound = valentineFound || annasFound;
    const strongMatch = (valentineFound && valentineMatchType === 'title') || annasFound;

    // Upgrade confidence si un connecteur a trouvé le livre. Un match Valentine
    // par auteur seulement (repli) reste en 'medium', pas 'high' — on n'a pas
    // confirme que ce livre precis y est, juste que l'auteur y est present.
    const confidence = strongMatch ? 'high' : (connectorFound ? 'medium' : predb.confidence);
    const available  = connectorFound || predb.available;

    // Message explicite par source (patch) : plus de formulation generique
    // "ce livre est disponible", on dit precisement OU il a ete trouve.
    let message;
    if (valentineFound && valentineMatchType === 'title' && annasFound) {
      message = 'Ebook trouvé sur Valentine et Anna\'s Archive.';
    } else if (valentineFound && valentineMatchType === 'title') {
      message = 'Ebook trouvé sur Valentine.';
    } else if (annasFound) {
      message = 'Ebook trouvé sur Anna\'s Archive.';
    } else if (valentineFound && valentineMatchType === 'author') {
      message = 'Ebook non trouvé directement, mais l\'auteur existe sur Valentine — ce livre précis pourrait être trouvable, sans garantie.';
    } else {
      message = predb.message;
    }

    // Construire la liste des sources qui ont confirmé la disponibilité
    const sources = [];
    if (valentineFound) sources.push(valentineMatchType === 'author' ? 'Valentine (auteur)' : 'Valentine');
    if (annasFound) sources.push("Anna's Archive");
    if (predb.match && (predb.score ?? 0) > 0) sources.push('predb.me');

    return res.json({
      success: true,
      available,
      confidence,
      message,
      match: predb.match,
      score: predb.score,
      sources,
    });

  } catch (error) {
    console.error('Erreur lors de la vérification de disponibilité:', error);
    return res.status(500).json({
      success: false,
      message: 'Erreur lors de la vérification de disponibilité',
      available: false,
      confidence: 'unknown'
    });
  }
});

export default router;
