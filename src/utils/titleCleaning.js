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

/**
 * Troisième cas, distinct des deux précédents : "Série N Titre" — numéro de
 * volume nu, sans séparateur ni mot-clé ("Hercule Poirot 20 Je ne suis pas
 * coupable", "Tommy et Tuppence Beresford 06 Le crime est notre affaire").
 * Aucun des deux motifs ci-dessus ne le reconnaît (pas de "tome"/"T", pas de
 * ":"), donc le titre complet part tel quel en recherche et échoue à tort
 * quand la source externe n'indexe que le sous-titre du volume.
 *
 * Volontairement en dernier recours dans getMetadataCandidates (jamais en
 * tête de liste) : un nombre au milieu d'un titre n'est pas toujours un
 * numéro de tome (ex. "20 000 lieues sous les mers") — le risque de faux
 * positif est réel, donc cette extraction n'est tentée qu'après l'échec de
 * toutes les requêtes plus fiables (titre exact, motifs structurés).
 *
 * Retourne null si le titre ne présente pas cette structure, ou si le
 * "sous-titre" extrait est trop court (1 mot) pour être une recherche fiable.
 */
export function extractBareVolumeSubtitle(title) {
  const m = (title || '').match(/^.+?\s+\d{1,3}\s+(.+)$/);
  const subtitle = m?.[1]?.trim();
  if (!subtitle || subtitle.split(/\s+/).length < 2) return null;
  return subtitle;
}
