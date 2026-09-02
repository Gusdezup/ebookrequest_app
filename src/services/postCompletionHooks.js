import path from 'path';
import { fileURLToPath } from 'url';
import User from '../models/User.js';
import { pushToCalibre } from './calibreService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Run all post-completion hooks for a book request.
 * @param {object} request - Mongoose BookRequest document (already saved as completed)
 * @param {string|object} userId - The user ID (request.user)
 */
export async function runPostCompletionHooks(request, userId) {
  const user = await User.findById(userId).select('calibreWeb');
  if (!user) return;

  // ── Calibre-Web push ────────────────────────────────────────────────────────
  if (user.calibreWeb?.enabled) {
    try {
      // Build absolute path from the relative filePath stored on the request
      // filePath is like "books/Frieren T05.mobi"
      const relativePath = request.filePath || '';
      const filePath = path.join(__dirname, '../../uploads', relativePath);

      // Étagères choisies au moment de la demande ; à défaut (anciennes
      // demandes, ou demande créée avant que l'utilisateur n'ait configuré
      // d'étagères), on retombe sur les étagères par défaut actuelles.
      const shelfNames = request.selectedShelves !== undefined
        ? request.selectedShelves
        : (user.calibreWeb.shelves || []).filter(s => s.isDefault).map(s => s.name);

      const result = await pushToCalibre(user, filePath, request.title, shelfNames);

      // Upload réussi mais au moins une étagère en échec → 'partial', pour
      // que le bouton "envoyer vers étagères" puisse cibler juste ce qui manque
      // sans reproposer un ré-upload complet.
      const hasShelfFailures = result?.shelfResult?.failed?.length > 0;

      request.calibrePush = {
        status: hasShelfFailures ? 'partial' : 'success',
        error: hasShelfFailures
          ? `Étagère(s) en échec : ${result.shelfResult.failed.map(f => f.name).join(', ')}`
          : null,
        pushedAt: new Date(),
        calibreBookId: result?.calibreBookId ?? null,
      };
      await request.save();
    } catch (err) {
      console.error(`[Calibre] Erreur push: ${err.message}`);
      request.calibrePush = {
        status: 'failed',
        error: err.message,
        pushedAt: new Date(),
        calibreBookId: null,
      };
      await request.save();
    }
  }
}