// Priorité : window.env (injecté par le backend au runtime) > import.meta.env (build time) > dev fallback
export const API_URL =
  (typeof window !== 'undefined' && window.env?.VITE_API_URL)
    ? window.env.VITE_API_URL
    : import.meta.env.VITE_API_URL || (import.meta.env.DEV ? 'http://localhost:5001' : '');
