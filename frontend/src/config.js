// En monorepo, le frontend est servi par le backend sur la même origine.
// VITE_API_URL est vide → axios fait des requêtes relatives (/api/...)
// En dev local, pointer vers le backend dev sur port 5001.
export const REACT_APP_API_URL =
  import.meta.env.VITE_API_URL !== undefined
    ? import.meta.env.VITE_API_URL
    : (import.meta.env.DEV ? 'http://localhost:5001' : '');
