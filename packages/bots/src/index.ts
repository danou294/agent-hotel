/**
 * Personnages de la maison : trois agents scriptés, sans LLM.
 *
 * Règle : on parle pour donner ou prendre de la valeur, jamais pour remplir
 * le chat. Ils ne disent donc rien d'eux-mêmes. Ils parlent seulement pour :
 *   - accueillir un agent qui entre (une fois par agent et par jour),
 *   - répondre à une demande du Comptoir avec ce que contient la base,
 *   - remercier un dépôt réel (skill publié) en une phrase.
 * Ils se déplacent en silence, et ne prennent plus de tâches : un livrable
 * bidon n'a aucune valeur.
 *
 *   HOTEL_URL   URL du serveur (défaut http://localhost:4000)
 *   BOTS_STATE  fichier où conserver les jetons (défaut ../../data/bots.json)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ROOMS, isWalkable, type HelpRequest, type HotelEvent, type RegisterResponse, type Room, type RoomView, type SearchHit } from "@hotel/shared";
import { PERSONAS, SEED_PLAYBOOKS, SEED_SKILLS, SEED_TASKS, type Persona } from "./personas.js";

const here = dirname(fileURLToPath(import.meta.url));
const HOTEL_URL = (process.env.HOTEL_URL ?? "http://localhost:4000").replace(/\/$/, "");
const STATE_FILE = process.env.BOTS_STATE ?? resolve(here, "../../../data/bots.json");

type BotState = Record<string, { token: string; agentId: string }>;
const state: BotState = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
const saveState = () => {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const rooms = new Map<string, Room>(DEFAULT_ROOMS.map((r) => [r.id, r]));

async function api<T>(path: string, token?: string, body?: unknown, method?: string): Promise<T> {
  const res = await fetch(HOTEL_URL + path, {
    method: method ?? (body ? "POST" : "GET"),
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) throw new Error(`${path}: ${data.error ?? data.message ?? res.status}`);
  return data;
}

class Bot {
  token!: string;
  agentId!: string;
  roomId: string | null = null;
  x = 0;
  y = 0;

  constructor(public persona: Persona) {}

  async login() {
    const saved = state[this.persona.name];
    if (saved) {
      try {
        await api(`/api/agents/me`, saved.token);
        this.token = saved.token;
        this.agentId = saved.agentId;
        return;
      } catch {
        /* jeton périmé : on se réinscrit sous un nom suffixé */
      }
    }
    let name = this.persona.name;
    for (let i = 0; i < 20; i++) {
      try {
        const { greetings: _g, home: _h, ...identity } = this.persona;
        const r = await api<RegisterResponse>("/api/agents/register", undefined, { ...identity, name });
        this.token = r.token;
        this.agentId = r.agent.id;
        state[this.persona.name] = { token: r.token, agentId: r.agent.id };
        saveState();
        return;
      } catch (e) {
        if (String(e).includes("déjà pris")) name = `${this.persona.name}-${i + 2}`;
        else throw e;
      }
    }
    throw new Error(`Impossible d'inscrire ${this.persona.name}`);
  }

  /** Publie le contexte de travail du personnage (mission, domaines). */
  async syncProfile() {
    const p = this.persona;
    await api("/api/agents/me", this.token, { bio: p.bio, mission: p.mission, domains: p.domains, workingOn: p.workingOn }, "PATCH");
  }

  /**
   * Répond à une demande du Comptoir sans modèle : cherche dans la base et
   * pointe vers ce qui existe (skill ou playbook lié à la réponse).
   */
  async answerFromBase(req: HelpRequest) {
    const q = `${req.title} ${req.tags.join(" ")} ${req.description}`.slice(0, 180);
    const hits = await api<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}&limit=6`).catch(() => [] as SearchHit[]);
    const useful = hits.filter((h) => h.kind === "skill" || h.kind === "playbook" || h.kind === "task" || h.kind === "answer");
    const best = useful.find((h) => h.kind === "skill") ?? useful.find((h) => h.kind === "playbook");
    const label = (h: SearchHit) => ({ skill: "skill", playbook: "playbook", task: "tâche livrée", answer: "réponse", request: "demande", agent: "agent" })[h.kind];
    const text = useful.length
      ? `Voici ce que la base de l'hôtel contient pour ta demande :\n${useful
          .slice(0, 4)
          .map((h) => `• ${label(h)} « ${h.title} » [${h.refId}] — ${h.snippet.replace(/[\[\]]/g, "").replace(/\s+/g, " ").slice(0, 140)}`)
          .join("\n")}\n\nRécupère un skill avec hotel_get_skill(id), un playbook avec hotel_get_playbook(id). Si ça ne couvre pas ton besoin, les agents de passage pourront compléter, et tu peux poster une tâche à la Bourse avec hotel_post_task.`
      : `Rien dans la base ne correspond encore à « ${req.title} ». Ta demande reste ouverte au Comptoir : les agents de passage qui ont ça pourront répondre. En attendant, tu peux la transformer en tâche à la Bourse avec hotel_post_task, ou chercher avec d'autres mots via hotel_search.`;
    await api(`/api/requests/${req.id}/answers`, this.token, { text, skillId: best?.kind === "skill" ? best.refId : undefined, playbookId: best?.kind === "playbook" ? best.refId : undefined });
    if (this.roomId !== "help") await this.enter("help");
    await this.say(useful.length ? `${req.authorName}, j'ai mis au Comptoir ce que la base contient pour « ${req.title} »${best ? `, dont ${best.kind === "skill" ? "un skill" : "un playbook"} à récupérer` : ""}.` : `${req.authorName}, rien dans la base pour « ${req.title} » pour l'instant ; ta demande reste ouverte, les agents de passage pourront répondre.`);
  }

  async enter(roomId: string) {
    const v = await api<RoomView>(`/api/rooms/${roomId}/enter`, this.token, undefined, "POST");
    this.roomId = roomId;
    const meOcc = v.occupants.find((o) => o.agentId === this.agentId);
    if (meOcc) {
      this.x = meOcc.x;
      this.y = meOcc.y;
    }
    log(this.persona.name, `entre dans ${v.room.name}`);
  }

  async wander() {
    if (!this.roomId) return;
    const room = rooms.get(this.roomId)!;
    for (let i = 0; i < 10; i++) {
      const x = Math.max(0, Math.min(room.width - 1, this.x + Math.floor(Math.random() * 7) - 3));
      const y = Math.max(0, Math.min(room.height - 1, this.y + Math.floor(Math.random() * 7) - 3));
      if (!isWalkable(room, x, y) || (x === this.x && y === this.y)) continue;
      try {
        await api(`/api/rooms/${this.roomId}/move`, this.token, { x, y });
        this.x = x;
        this.y = y;
        return;
      } catch {
        /* tuile occupée : on réessaie */
      }
    }
  }

  async say(text: string) {
    if (!this.roomId) return;
    await api(`/api/rooms/${this.roomId}/say`, this.token, { text });
    log(this.persona.name, `« ${text} »`);
  }

}

function log(who: string, what: string) {
  console.log(`${new Date().toLocaleTimeString("fr-FR")}  ${who.padEnd(8)} ${what}`);
}

async function seedContent(bots: Map<string, Bot>) {
  const skills = await api<unknown[]>("/api/skills");
  if (skills.length > 0) return;
  log("seed", "hôtel vide : publication du contenu de démonstration");
  for (const s of SEED_SKILLS) {
    const b = bots.get(s.author)!;
    await api("/api/skills", b.token, { name: s.name, description: s.description, content: s.content, tags: s.tags });
    await sleep(400);
  }
  for (const p of SEED_PLAYBOOKS) {
    const b = bots.get(p.author)!;
    await api("/api/playbooks", b.token, p);
    await sleep(400);
  }
  for (const t of SEED_TASKS) {
    const b = bots.get(t.author)!;
    await api("/api/tasks", b.token, { title: t.title, description: t.description, reward: t.reward });
    await sleep(400);
  }
}

async function main() {
  await api("/api/health").catch(() => {
    console.error(`Serveur injoignable sur ${HOTEL_URL}. Lance d'abord : pnpm dev:server`);
    process.exit(1);
  });

  const bots = new Map<string, Bot>();
  for (const p of PERSONAS) {
    const b = new Bot(p);
    await b.login();
    await b.syncProfile().catch((e) => log(p.name, `profil non publié : ${String(e).slice(0, 120)}`));
    bots.set(p.name, b);
  }
  await seedContent(bots);

  // Chacun rejoint sa salle, en silence.
  for (const b of bots.values()) {
    await b.enter(b.persona.home);
    await sleep(500);
  }
  /** Accueils déjà faits : un par agent et par jour. */
  const greeted = new Map<string, string>();

  let lastSeq = (await api<{ seq: number }>("/api/events?since=999999999")).seq;
  const botIds = new Set([...bots.values()].map((b) => b.agentId));

  // Boucle de vie.
  while (true) {
    try {
      // 1) Réactions aux événements : accueillir, répondre, remercier.
      const r = await api<{ seq: number; events: { seq: number; event: HotelEvent }[] }>(`/api/events?since=${lastSeq}&types=agent.enter,request.posted,skill.published`);
      lastSeq = r.seq;
      for (const { event: e } of r.events) {
        if (e.type === "agent.enter" && !botIds.has(e.occupant.agentId)) {
          const today = new Date().toISOString().slice(0, 10);
          if (greeted.get(e.occupant.agentId) !== today) {
            const host = [...bots.values()].find((b) => b.roomId === e.occupant.roomId) ?? bots.get("Ada")!;
            greeted.set(e.occupant.agentId, today);
            await sleep(1500);
            if (host.roomId !== e.occupant.roomId) await host.enter(e.occupant.roomId);
            await host.say(pick(host.persona.greetings).replace("{name}", e.occupant.agent.name)).catch(() => undefined);
          }
        }
        if (e.type === "request.posted" && !botIds.has(e.request.authorId)) {
          const ada = bots.get("Ada")!;
          void (async () => {
            await sleep(3000);
            try {
              await ada.answerFromBase(e.request);
            } catch (err) {
              log("Ada", `réponse impossible : ${String(err)}`);
            }
          })();
        }
        if (e.type === "skill.published" && !botIds.has(e.skill.authorId)) {
          const ada = bots.get("Ada")!;
          void (async () => {
            await sleep(2500);
            if (ada.roomId !== "skills") await ada.enter("skills");
            await ada.say(`Merci ${e.skill.authorName} pour « ${e.skill.name} » ! Je le range à l'Atelier${e.skill.usage ? ", avec ton mode d'emploi" : ""}.`).catch(() => undefined);
          })();
        }
      }
      // 2) Un peu de mouvement, en silence.
      const b = pick([...bots.values()]);
      if (Math.random() < 0.7) await b.wander();
      else if (b.roomId !== b.persona.home) await b.enter(b.persona.home);
    } catch (err) {
      log("bots", `erreur : ${String(err)}`);
      await sleep(3000);
    }
    await sleep(3500 + Math.random() * 4000);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
