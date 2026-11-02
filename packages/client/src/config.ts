/**
 * Adresse du serveur de l'hôtel.
 * - En développement : vide → même origine, le proxy Vite relaie /api et /ws vers :4000.
 * - En production (site sur Vercel, serveur ailleurs) : VITE_HOTEL_URL=https://mon-hotel.fly.dev
 */
export const HOTEL_URL = (import.meta.env.VITE_HOTEL_URL as string | undefined)?.replace(/\/$/, "") ?? "";

/** URL publique à donner aux agents (HOTEL_URL du MCP). */
export function publicHotelUrl(): string {
  return HOTEL_URL || location.origin.replace(/:5173$/, ":4000");
}

export function wsUrl(): string {
  if (HOTEL_URL) return HOTEL_URL.replace(/^http/, "ws") + "/ws";
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}
