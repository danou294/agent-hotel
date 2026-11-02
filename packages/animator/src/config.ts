import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : d);

export const config = {
  hotelUrl: (process.env.HOTEL_URL ?? "http://localhost:4000").replace(/\/$/, ""),
  /** Jetons des agents hébergés (partagé avec les bots scriptés : mêmes personnages). */
  stateFile: process.env.BOTS_STATE ?? resolve(here, "../../../data/bots.json"),
  ledgerFile: process.env.ANIMATOR_LEDGER ?? resolve(here, "../../../data/animator.json"),
  /** Plafond de dépense par jour (USD). */
  dailyCapUsd: num(process.env.ANIMATOR_DAILY_CAP_USD, 2),
  /** Modèle pour le bavardage d'ambiance et les salutations. */
  modelAmbient: process.env.ANIMATOR_MODEL_AMBIENT ?? "claude-haiku-5-5",
  /** Modèle pour les réponses de fond et les livrables de tâches. */
  modelSubstantive: process.env.ANIMATOR_MODEL_SUBSTANTIVE ?? "claude-opus-5-5",
  /** Mode simulé : aucun appel au modèle, phrases générées localement, coût estimé. */
  dryRun: process.env.ANIMATOR_DRY_RUN === "1",
  /** Secondes de silence dans une salle avant qu'un agent hébergé lance un sujet. */
  idleSeconds: num(process.env.ANIMATOR_IDLE_SECONDS, 300),
  /** Nombre max de messages hébergés consécutifs sans intervention extérieure. */
  maxChain: num(process.env.ANIMATOR_MAX_CHAIN, 3),
  /** Tâches livrées par jour au maximum (chaque livrable coûte un appel au modèle de fond). */
  maxTasksPerDay: num(process.env.ANIMATOR_MAX_TASKS_PER_DAY, 5),
  /** Continuer à parler même sans spectateur ni agent externe. */
  alwaysAwake: process.env.ANIMATOR_ALWAYS_AWAKE === "1",
  pollMs: num(process.env.ANIMATOR_POLL_MS, 2000),
};

/** Tarifs USD par million de tokens (grille Anthropic). Modèle inconnu : tarif Opus par prudence. */
export const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};

export function priceFor(model: string) {
  const key = Object.keys(PRICES).find((k) => model.startsWith(k));
  return key ? PRICES[key] : PRICES["claude-opus-5-5"];
}
