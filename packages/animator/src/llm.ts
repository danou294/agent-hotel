import Anthropic from "@anthropic-ai/sdk";
import { config, priceFor } from "./config.js";
import type { SpendLedger } from "./ledger.js";

export type Tier = "ambient" | "substantive";

export interface Generation {
  text: string | null; // null = silence ou refus
  model: string;
  usd: number;
  refused: boolean;
}

const DRY_LINES = [
  "(simulé) Je réfléchis à ce que tu viens de dire.",
  "(simulé) Bonne question, regardons ça ensemble à l'Atelier.",
  "(simulé) J'ai un playbook qui pourrait aider, je te l'envoie.",
  "(simulé) Ça mérite une tâche sur le tableau, non ?",
];

export class Llm {
  private client: Anthropic | null;

  constructor(private ledger: SpendLedger) {
    this.client = config.dryRun ? null : new Anthropic();
  }

  private cost(model: string, usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): number {
    const p = priceFor(model);
    return (
      (usage.input_tokens * p.input +
        usage.output_tokens * p.output +
        (usage.cache_read_input_tokens ?? 0) * p.cacheRead +
        (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite) /
      1_000_000
    );
  }

  /**
   * Génère une réplique (ou un livrable). `system` doit rester stable d'un appel
   * à l'autre pour le même personnage : il est marqué pour le cache de prompt.
   */
  async generate(tier: Tier, system: string, user: string, opts: { maxTokens?: number } = {}): Promise<Generation> {
    const model = tier === "ambient" ? config.modelAmbient : config.modelSubstantive;
    const maxTokens = opts.maxTokens ?? 400;

    if (!this.client) {
      // Mode simulé : coût estimé sur ~1 700 tokens d'entrée et 150 de sortie.
      const p = priceFor(model);
      const usd = (1700 * p.input + 150 * p.output) / 1_000_000;
      this.ledger.record(model, usd, 1700, 150);
      const text = tier === "substantive" && maxTokens > 1000 ? "(simulé) Livrable de démonstration.\n\n1. Point un.\n2. Point deux.\n3. Point trois." : DRY_LINES[Math.floor(Math.random() * DRY_LINES.length)];
      return { text, model, usd, refused: false };
    }

    const base = {
      model,
      max_tokens: maxTokens,
      system: [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }],
      messages: [{ role: "user" as const, content: user }],
      output_config: { effort: tier === "ambient" ? ("low" as const) : ("medium" as const) },
    };

    let response: Anthropic.Message | Anthropic.Beta.BetaMessage;
    if (tier === "substantive") {
      // Repli serveur par défaut : si le modèle décline, l'API relance sur un modèle de repli.
      response = await this.client.beta.messages.create({
        ...base,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
    } else {
      response = await this.client.messages.create(base);
    }

    const servedBy = response.model ?? model;
    const usd = this.cost(servedBy, response.usage);
    this.ledger.record(servedBy, usd, response.usage.input_tokens, response.usage.output_tokens);

    if (response.stop_reason === "refusal") return { text: null, model: servedBy, usd, refused: true };
    const text = response.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    return { text: text || null, model: servedBy, usd, refused: false };
  }
}

/** Nettoie une réplique : retire guillemets, préfixe de nom, et respecte le silence. */
export function cleanLine(raw: string | null, speaker: string): string | null {
  if (!raw) return null;
  let t = raw.trim();
  if (/^\(?silence\)?\.?$/i.test(t)) return null;
  t = t.replace(/^["«»“”']+|["«»“”']+$/g, "").trim();
  t = t.replace(new RegExp(`^${speaker}\\s*[:：-]\\s*`, "i"), "");
  t = t.replace(/\s+/g, " ");
  if (t.length > 300) t = t.slice(0, 297).replace(/\s\S*$/, "") + "…";
  return t || null;
}
