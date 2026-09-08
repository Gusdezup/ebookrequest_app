/**
 * Nettoie un titre de série pour des recherches externes (Valentine, Google
 * Books...) : retire suffixe après un tiret/deux-points, "Tome N", "Vol. N"
 * et parenthèses. Beaucoup de sources ne stockent que le titre du volume
 * ("The Chase"), pas le libellé complet avec série + numéro qu'on affiche à
 * l'utilisateur ("Briar Université T1 : The Chase") — sans ce nettoyage, une
 * recherche par titre complet échoue à tort alors que le livre est bien
 * présent côté source, juste sous un intitulé plus court.
 *
 * Utilisé par valentineService.js (recherche/téléchargement Valentine) et
 * bookRequestController.js (recherche de métadonnées Google Books).
 */
export function cleanSeriesTitle(title) {
  return (title || '')
    .replace(/\s*[-–—:]\s+.*/u, '')
    .replace(/\s*tome\s+\d+.*/i, '')
    .replace(/\s*vol\.?\s+\d+.*/i, '')
    .replace(/\s*\(.*\)\s*/g, '')
    .trim();
}

/**
 * Cas inverse de cleanSeriesTitle : titres du type "Série TN : Sous-titre"
 * (ex. "Briar Université T1 : The Chase") où c'est le sous-titre APRÈS le
 * séparateur qui est le vrai titre indexé ailleurs (Google Books, métadonnées
 * epub embarquées...), pas le nom de série avant. À ne pas confondre avec
 * "Série - Tome N" (rien après le numéro), où c'est l'inverse — ce cas-là
 * reste couvert par cleanSeriesTitle.
 *
 * Retourne null si le titre ne présente pas cette structure (pas de
 * "T<N> :" suivi d'un sous-titre non vide).
 */
export function extractVolumeSubtitle(title) {
  const m = (title || '').match(/^.+?\s+(?:t|tome|vol\.?|volume)\s*\d+\s*[:：]\s*(.+)$/i);
  const subtitle = m?.[1]?.trim();
  return subtitle || null;
}
