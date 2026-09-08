/**
 * Normalise une chaîne pour comparaison approximative : minuscules, accents
 * retirés, ponctuation → espace, espaces multiples compactés.
 */
export function normalizeForMatch(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // supprimer les accents
    .replace(/[.,'"“”‘’]/g, ' ')        // ponctuation → espace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Score de correspondance auteur entre 0 et 1 : proportion des mots de
 * requestAuthor retrouvés (par égalité ou préfixe) dans resultAuthor, dans
 * n'importe quel ordre — insensible au format "Prénom Nom" vs "Nom Prénom"
 * (Valentine renvoie souvent l'ordre inversé par rapport à Google Books).
 * Retourne 1 si requestAuthor est vide (rien à vérifier, ne pas pénaliser).
 */
export function authorMatchScore(requestAuthor, resultAuthor) {
  if (!requestAuthor) return 1;
  const reqTokens = normalizeForMatch(requestAuthor).split(' ').filter(t => t.length > 1);
  if (!reqTokens.length) return 1;
  if (!resultAuthor) return 0;
  const resTokens = normalizeForMatch(resultAuthor).split(' ').filter(t => t.length > 1);
  let matches = 0;
  for (const rw of reqTokens) {
    if (resTokens.some(w => w === rw || w.startsWith(rw) || rw.startsWith(w))) matches++;
  }
  return matches / reqTokens.length;
}

/**
 * Score de correspondance titre entre 0 et 1, comparé contre PLUSIEURS
 * titres candidats à la fois (utile quand on a un titre affiché complet, un
 * sous-titre extrait, un nom de série nettoyé... — on ne sait pas à l'avance
 * lequel correspond au champ titre réel de la source externe, donc on garde
 * le meilleur score parmi tous les candidats).
 *
 * Paliers : 1 = égalité stricte après normalisation ; 0.8 = l'un contient
 * l'autre en entier (ex. "The Chase" contenu dans un candidat plus long) ;
 * sinon proportion de mots du candidat retrouvés dans le résultat, plafonnée
 * à 0.6 pour ne jamais dépasser un vrai match partiel/exact.
 */
export function titleMatchScore(candidateTitles, resultTitle) {
  const resNorm = normalizeForMatch(resultTitle);
  if (!resNorm) return 0;

  let best = 0;
  for (const candidate of candidateTitles) {
    const candNorm = normalizeForMatch(candidate);
    if (!candNorm) continue;

    let score;
    if (candNorm === resNorm) {
      score = 1;
    } else if (candNorm.includes(resNorm) || resNorm.includes(candNorm)) {
      score = 0.8;
    } else {
      const candTokens = candNorm.split(' ').filter(t => t.length > 1);
      const resTokens = resNorm.split(' ').filter(t => t.length > 1);
      if (!candTokens.length) {
        score = 0;
      } else {
        const matches = candTokens.filter(t => resTokens.includes(t)).length;
        score = (matches / candTokens.length) * 0.6;
      }
    }
    if (score > best) best = score;
  }
  return best;
}
