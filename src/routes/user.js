import express from 'express';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth.js';
import { updateUserProfile, verifyEmail, getCurrentUser, changePassword, updateAvatar, getUserStats } from '../controllers/userController.js';
import User from '../models/User.js';
import { encrypt, decrypt } from '../services/cryptoService.js';
import { testCalibreConnection, pushToCalibre } from '../services/calibreService.js';
import BookRequest from '../models/BookRequest.js';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Récupérer le profil de l'utilisateur connecté
router.get('/me', requireAuth, getCurrentUser);

// Stats du profil
router.get('/me/stats', requireAuth, getUserStats);

// Mettre à jour le profil utilisateur
router.put('/profile', requireAuth, updateUserProfile);

// Mettre à jour l'avatar (base64)
router.put('/avatar', requireAuth, updateAvatar);

// Vérifier l'email avec un token
router.get('/verify-email/:token', verifyEmail);

// Changer le mot de passe
router.put('/change-password', requireAuth, changePassword);

// GET /api/users/opds-token — get (or generate) the user's OPDS token
router.get('/opds-token', requireAuth, async (req, res) => {
  try {
    let user = await User.findById(req.user.id).select('opdsToken');
    if (!user.opdsToken) {
      const token = crypto.randomUUID();
      await User.updateOne({ _id: req.user.id }, { $set: { opdsToken: token } });
      user.opdsToken = token;
    }
    const baseUrl = process.env.FRONTEND_URL || '';
    res.json({
      success: true,
      token: user.opdsToken,
      feedUrl: `${baseUrl}/api/opds/${user.opdsToken}`
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/users/opds-token/regenerate — regenerate OPDS token
router.post('/opds-token/regenerate', requireAuth, async (req, res) => {
  try {
    const token = crypto.randomUUID();
    await User.updateOne({ _id: req.user.id }, { $set: { opdsToken: token } });
    const baseUrl = process.env.FRONTEND_URL || '';
    res.json({
      success: true,
      token,
      feedUrl: `${baseUrl}/api/opds/${token}`
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── Calibre-Web routes ────────────────────────────────────────────────────────

// GET /api/users/calibre
router.get('/calibre', requireAuth, async (req, res) => {
  try {
    const [user, lastSyncDoc] = await Promise.all([
      User.findById(req.user.id).select('calibreWeb'),
      BookRequest.findOne(
        { user: req.user.id, 'calibrePush.status': 'success' },
        { 'calibrePush.pushedAt': 1 },
        { sort: { 'calibrePush.pushedAt': -1 } }
      ),
    ]);
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    const cfg = user.calibreWeb || {};
    res.json({
      enabled:     cfg.enabled || false,
      url:         cfg.url || '',
      username:    cfg.username || '',
      hasPassword: Boolean(cfg.password),
      shelfName:   cfg.shelfName || '',
      lastSync:    lastSyncDoc?.calibrePush?.pushedAt || null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/users/calibre
router.put('/calibre', requireAuth, async (req, res) => {
  try {
    const { enabled, url, username, password, shelfName } = req.body;
    const user = await User.findById(req.user.id).select('calibreWeb');
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    const existing = user.calibreWeb || {};
    const updates = {
      'calibreWeb.enabled':    enabled !== undefined ? Boolean(enabled) : existing.enabled,
      'calibreWeb.url':        url !== undefined ? url : existing.url,
      'calibreWeb.username':   username !== undefined ? username : existing.username,
      'calibreWeb.shelfName':  shelfName !== undefined ? shelfName.trim() : (existing.shelfName || ''),
    };
    if (password) updates['calibreWeb.password'] = encrypt(password);
    await User.findByIdAndUpdate(req.user.id, { $set: updates });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/users/calibre/test
router.post('/calibre/test', requireAuth, async (req, res) => {
  try {
    let { url, username, password } = req.body;

    // Si aucun mot de passe fourni (déjà sauvegardé), utiliser celui en BDD
    if (!password) {
      const user = await User.findById(req.user.id).select('calibreWeb');
      if (user?.calibreWeb?.password) password = decrypt(user.calibreWeb.password);
      if (!url      && user?.calibreWeb?.url)      url      = user.calibreWeb.url;
      if (!username && user?.calibreWeb?.username) username = user.calibreWeb.username;
    }

    const result = await testCalibreConnection({ url, username, password });
    res.json(result);
  } catch (err) {
    res.status(500).json({ connected: false, error: err.message });
  }
});

// POST /api/users/calibre/sync — push all completed requests not yet sent to Calibre
router.post('/calibre/sync', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('calibreWeb');
    if (!user?.calibreWeb?.enabled) {
      return res.status(400).json({ error: 'Calibre-Web non configuré ou désactivé' });
    }

    // Demandes complétées avec un fichier, pas encore envoyées avec succès
    const requests = await BookRequest.find({
      user: req.user.id,
      status: 'completed',
      filePath: { $exists: true, $ne: '' },
      'calibrePush.status': { $ne: 'success' },
    });

    if (!requests.length) {
      return res.json({ pushed: 0, failed: 0, skipped: 0, message: 'Aucun livre à synchroniser' });
    }

    let pushed = 0, failed = 0, skipped = 0;
    const { existsSync } = await import('fs');

    for (const request of requests) {
      try {
        const filePath = path.join(__dirname, '../../uploads', request.filePath);

        // Fichier introuvable → skip silencieux
        if (!existsSync(filePath)) {
          skipped++;
          console.warn(`[Calibre] Sync skip "${request.title}": fichier introuvable`);
          continue;
        }

        await pushToCalibre(user, filePath, request.title);
        request.calibrePush = { status: 'success', error: null, pushedAt: new Date() };
        await request.save();
        pushed++;
        console.log(`[Calibre] Sync ✓ "${request.title}"`);
      } catch (err) {
        request.calibrePush = { status: 'failed', error: err.message, pushedAt: new Date() };
        await request.save();
        failed++;
        console.error(`[Calibre] Sync ✗ "${request.title}": ${err.message}`);
      }
    }

    const lastSync = pushed > 0 ? new Date() : null;
    res.json({ pushed, failed, skipped, total: requests.length, lastSync });
  } catch (err) {
    console.error('[Calibre] sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Valentine routes (credentials personnels user) ────────────────────────────

// GET /api/users/valentine
router.get('/valentine', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('valentine');
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    res.json({
      username:    user.valentine?.username || '',
      hasPassword: Boolean(user.valentine?.password),
    });
  } catch {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/users/valentine
router.put('/valentine', requireAuth, async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findById(req.user.id).select('valentine');
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });

    const updates = {};
    if (username !== undefined) updates['valentine.username'] = username.trim();
    if (password)               updates['valentine.password'] = encrypt(password);
    // Si username vide → supprimer les credentials
    if (username?.trim() === '' && !password) {
      updates['valentine.username'] = '';
      updates['valentine.password'] = '';
    }

    await User.findByIdAndUpdate(req.user.id, { $set: updates });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/users/valentine/quota
router.get('/valentine/quota', requireAuth, async (req, res) => {
  try {
    const { getValentineQuota } = await import('../services/valentineService.js');
    const user = await User.findById(req.user.id).select('valentine');
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });

    const raw = user?.valentine?.password || '';
    const password = decrypt(raw) ?? raw;
    const username = user?.valentine?.username || '';

    if (!username || !password) {
      return res.status(400).json({ error: 'Aucun compte Valentine configuré' });
    }

    const quota = await getValentineQuota(username, password);
    res.json(quota);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erreur lors de la récupération du quota' });
  }
});

// POST /api/users/valentine/test
router.post('/valentine/test', requireAuth, async (req, res) => {
  try {
    const { testConnectionValentine } = await import('../services/valentineService.js');
    let { username, password } = req.body;

    if (!password || password === '••••••••') {
      const user = await User.findById(req.user.id).select('valentine');
      const raw = user?.valentine?.password || '';
      password = decrypt(raw) ?? raw;
      if (!username) username = user?.valentine?.username || '';
    }

    if (!username || !password) {
      return res.status(400).json({ error: 'Identifiant et mot de passe requis' });
    }

    await testConnectionValentine(username.trim(), password);
    res.json({ success: true, message: 'Connexion réussie — valentine.wtf' });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Connexion impossible' });
  }
});

// GET /api/users/hardcover
router.get('/hardcover', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('hardcover');
    if (!user) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    res.json({
      enabled: user.hardcover?.enabled ?? false,
      apiKey: user.hardcover?.apiKey ? '••••••••' : '',
      _hasApiKey: !!user.hardcover?.apiKey,
      _keyUpdatedAt: user.hardcover?.apiKey ? user.hardcover?.apiKeySavedAt : null,
    });
  } catch {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /api/users/hardcover
router.put('/hardcover', requireAuth, async (req, res) => {
  try {
    const { enabled, apiKey, _hasApiKey } = req.body;
    const updates = { 'hardcover.enabled': !!enabled };

    // apiKey n'est touchée que si le champ est explicitement présent dans la requête
    // (le toggle "activer" seul n'envoie que { enabled }, pour ne jamais risquer
    // d'effacer une clé déjà enregistrée par erreur d'état côté front).
    if (apiKey !== undefined) {
      if (apiKey && apiKey !== '••••••••') {
        updates['hardcover.apiKey'] = encrypt(apiKey);
        updates['hardcover.apiKeySavedAt'] = new Date();
      } else if (!apiKey && !_hasApiKey) {
        updates['hardcover.apiKey'] = '';
        updates['hardcover.apiKeySavedAt'] = null;
      }
    }

    const user = await User.findByIdAndUpdate(req.user.id, { $set: updates }, { new: true }).select('hardcover');
    res.json({
      enabled: user.hardcover?.enabled ?? false,
      apiKey: user.hardcover?.apiKey ? '••••••••' : '',
      _hasApiKey: !!user.hardcover?.apiKey,
      _keyUpdatedAt: user.hardcover?.apiKey ? user.hardcover?.apiKeySavedAt : null,
    });
  } catch {
    res.status(500).json({ error: 'Erreur lors de la sauvegarde' });
  }
});

// POST /api/users/hardcover/test
router.post('/hardcover/test', requireAuth, async (req, res) => {
  try {
    let { apiKey } = req.body;
    if (!apiKey || apiKey === '••••••••') {
      const user = await User.findById(req.user.id).select('hardcover');
      const raw = user?.hardcover?.apiKey || '';
      apiKey = decrypt(raw) ?? raw;
    }
    if (!apiKey) return res.status(400).json({ error: 'Clé API non renseignée' });

    const response = await fetch('https://api.hardcover.app/v1/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query: '{ me { username } }' }),
    });
    const data = await response.json();
    if (!response.ok || data?.errors) {
      const reason = data?.errors?.[0]?.message || `HTTP ${response.status}`;
      return res.status(400).json({ error: reason });
    }
    res.json({ success: true, message: 'Clé Hardcover valide' });
  } catch (err) {
    res.status(500).json({ error: `Test impossible : ${err.message || 'Erreur inconnue'}` });
  }
});

// POST /api/users/hardcover/sync-now
router.post('/hardcover/sync-now', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('_id username hardcover');
    if (!user?.hardcover?.enabled || !user?.hardcover?.apiKey) {
      return res.status(400).json({ error: 'Synchro Hardcover non activée' });
    }
    // Peut prendre plusieurs minutes sur une grosse bibliothèque (rate-limit Hardcover
    // respecté par hardcoverSyncService) — on répond tout de suite, ça tourne en fond.
    const { syncUserLibrary } = await import('../services/hardcoverSyncCron.js');
    syncUserLibrary(user, { force: true }).catch(err => {
      console.warn(`[HardcoverSync] Échec synchro manuelle pour ${user.username}:`, err.message);
    });
    res.json({ success: true, message: 'Synchronisation lancée en arrière-plan — ça peut prendre quelques minutes.' });
  } catch {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/users/hardcover/import
router.post('/hardcover/import', requireAuth, async (req, res) => {
  try {
    const { importHardcoverLibrary } = await import('../services/hardcoverSyncService.js');
    const result = await importHardcoverLibrary(req.user.id);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({
      success: true,
      message: `${result.imported} livre(s) importé(s), ${result.skipped} déjà présent(s) dans votre bibliothèque.`,
      ...result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Erreur lors de l\'import' });
  }
});

export default router;