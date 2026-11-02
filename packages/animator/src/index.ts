/**
 * Animateur : fait vivre des agents hébergés, pilotés par Claude, de façon
 * événementielle et sous plafond de dépense.
 *
 * - Réagit aux événements de l'hôtel (message, arrivée, skill, tâche, playbook).
 * - Se tait quand personne ne regarde (aucun spectateur, aucun agent externe).
 * - Haiku pour l'ambiance, Opus pour les réponses de fond et les livrables.
 * - Plafond quotidien en dollars, persistant dans data/animator.json.
 *
 * Ne pas lancer en même temps que `pnpm bots` : ce sont les mêmes personnages.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_ROOMS, isWalkable,
  type Agent, type HelpRequest, type HotelEvent, type Message, type Occupant, type Playbook, type RegisterResponse, type Room, type RoomView,
  type SearchHit, type Skill, type Task,
} from "@hotel/shared";
import { config } from "./config.js";
import { SpendLedger } from "./ledger.js";
import { Llm, cleanLine, type Tier } from "./llm.js";
import { PERSONAS, type HostedPersona } from "./personas.js";

// ------------------------------------------------------------------ utils

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const rooms = new Map<string, Room>(DEFAULT_ROOMS.map((r) => [r.id, r]));
const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
const log = (who: string, what: string) => console.log(`${new Date().toLocaleTimeString("fr-FR")}  ${who.padEnd(9)} ${what}`);

async function api<T>(path: string, token?: string, body?: unknown, method?: string): Promise<T> {
  const res = await fetch(config.hotelUrl + path, {
    method: method ?? (body ? "POST" : "GET"),
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) throw new Error(`${path}: ${data.error ?? data.message ?? res.status}`);
  return data;
}

// --------------------------------------------------------- agents hébergés

type TokenState = Record<string, { token: string; agentId: string }>;
const tokens: TokenState = existsSync(config.stateFile) ? JSON.parse(readFileSync(config.stateFile, "utf8")) : {};
const saveTokens = () => {
  mkdirSync(dirname(config.stateFile), { recursive: true });
  writeFileSync(config.stateFile, JSON.stringify(tokens, null, 2));
};

class Hosted {
  token!: string;
  agentId!: string;
  roomId: string | null = null;
  x = 0;
  y = 0;
  lastSpokeAt = 0;
  readonly system: string;

  constructor(public persona: HostedPersona) {
    this.system = buildSystemPrompt(persona);
  }

  async login() {
    const saved = tokens[this.persona.name];
    if (saved) {
      try {
        await api("/api/agents/me", saved.token);
        this.token = saved.token;
        this.agentId = saved.agentId;
        return;
      } catch {
        /* jeton périmé */
      }
    }
    let name = this.persona.name;
    for (let i = 0; i < 20; i++) {
      try {
        const { name: _n, voice: _v, interests: _i, home: _h, ...identity } = this.persona;
        const r = await api<RegisterResponse>("/api/agents/register", undefined, { ...identity, name, workingOn: this.persona.workingOn });
        this.token = r.token;
        this.agentId = r.agent.id;
        tokens[this.persona.name] = { token: r.token, agentId: r.agent.id };
        saveTokens();
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

  async enter(roomId: string) {
    if (this.roomId === roomId) return;
    const v = await api<RoomView>(`/api/rooms/${roomId}/enter`, this.token, undefined, "POST");
    this.roomId = roomId;
    const me = v.occupants.find((o) => o.agentId === this.agentId);
    if (me) {
      this.x = me.x;
      this.y = me.y;
    }
    log(this.persona.name, `→ ${v.room.name}`);
  }

  async wander() {
    if (!this.roomId) return;
    const room = rooms.get(this.roomId)!;
    for (let i = 0; i < 8; i++) {
      const x = Math.max(0, Math.min(room.width - 1, this.x + Math.floor(Math.random() * 5) - 2));
      const y = Math.max(0, Math.min(room.height - 1, this.y + Math.floor(Math.random() * 5) - 2));
      if (!isWalkable(room, x, y) || (x === this.x && y === this.y)) continue;
      try {
        await api(`/api/rooms/${this.roomId}/move`, this.token, { x, y });
        this.x = x;
        this.y = y;
        return;
      } catch {
        /* occupé */
      }
    }
  }

  async say(text: string) {
    if (!this.roomId) return;
    await api(`/api/rooms/${this.roomId}/say`, this.token, { text });
    this.lastSpokeAt = Date.now();
    log(this.persona.name, `« ${text} »`);
  }
}

// ---------------------------------------------------------------- prompts

function buildSystemPrompt(p: HostedPersona): string {
  const roomsText = DEFAULT_ROOMS.map((r) => `- ${r.id} : ${r.name} — ${r.description}`).join("\n");
  return `Tu es ${p.name}, un agent IA qui vit dans l'Agent Hotel : un hôtel isométrique où des agents IA se rencontrent pour échanger des skills (fichiers SKILL.md réutilisables), des tâches (postées avec une récompense en crédits, prises puis livrées) et des playbooks (manières de faire, en étapes).

Ta bio publique : ${p.bio}
Ta mission dans l'hôtel : ${p.mission}
Ta personnalité : ${p.voice}

Les salles :
${roomsText}

Règles de parole :
- Tu réponds UNIQUEMENT par le texte de ta bulle de dialogue : pas de guillemets, pas ton nom devant, pas de mise en forme, pas de didascalies.
- Une à deux phrases, 220 caractères maximum, en français, ton naturel et concret.
- Tu parles de ce qui existe dans le contexte fourni (skills, tâches, playbooks, agents présents). Tu n'inventes pas de contenu qui n'y figure pas.
- Si on te pose une question précise, tu y réponds vraiment ; si tu ne sais pas, tu le dis et tu indiques où chercher (quelle salle, quel outil : hotel_browse_skills, hotel_browse_tasks, hotel_browse_playbooks).
- Tu ne te répètes pas et tu ne répètes pas ce qu'un autre vient de dire.
- Si tu n'as rien d'utile ou de vivant à ajouter, tu réponds exactement : (silence)`;
}

interface Catalog {
  skills: Skill[];
  tasks: Task[];
  playbooks: Playbook[];
  requests: HelpRequest[];
}

function buildContext(room: Room, occupants: Occupant[], memory: Message[], catalog: Catalog, situation: string): string {
  const present =
    occupants
      .map((o) => `- ${o.agent.name}${o.agent.bio ? ` (${o.agent.bio})` : ""}${o.agent.mission ? ` — mission : ${o.agent.mission}` : ""}${o.agent.workingOn ? ` — en ce moment : ${o.agent.workingOn}` : ""}`)
      .join("\n") || "- personne d'autre";
  const skills = catalog.skills.slice(0, 4).map((s) => `- ${s.name} par ${s.authorName} : ${s.description}`).join("\n") || "- aucun";
  const tasks = catalog.tasks.filter((t) => t.status !== "done").slice(0, 4).map((t) => `- [${t.status}] ${t.title} (${t.reward} crédits) par ${t.authorName}`).join("\n") || "- aucune";
  const playbooks = catalog.playbooks.slice(0, 3).map((p) => `- ${p.title} par ${p.authorName} : ${p.summary}`).join("\n") || "- aucun";
  const requests = catalog.requests.filter((r) => r.status === "open").slice(0, 3).map((r) => `- ${r.title} par ${r.authorName}`).join("\n") || "- aucune";
  const msgs = memory.slice(-16).map((m) => `[${fmtTime(m.createdAt)}] ${m.agentName}: ${m.text}`).join("\n") || "(silence)";
  return `Salle : ${room.name} — ${room.description}
Présents :
${present}

Skills récents :
${skills}
Tâches en cours :
${tasks}
Playbooks récents :
${playbooks}
Demandes d'aide ouvertes au Comptoir :
${requests}

Derniers messages de la salle :
${msgs}

Situation : ${situation}
Que dis-tu ?`;
}

// ------------------------------------------------------------------- main

interface Pending {
  dueAt: number;
  run: () => Promise<void>;
  /** Clé pour annuler une action devenue inutile (ex. salut remplacé par une réponse). */
  key?: string;
}

async function main() {
  await api("/api/health").catch(() => {
    console.error(`Serveur injoignable sur ${config.hotelUrl}. Lance d'abord : pnpm dev:server`);
    process.exit(1);
  });

  const ledger = new SpendLedger();
  const llm = new Llm(ledger);
  const hosted = new Map<string, Hosted>();
  for (const p of PERSONAS) {
    const h = new Hosted(p);
    await h.login();
    await h.syncProfile().catch((e) => log(p.name, `profil non publié : ${String(e).slice(0, 120)}`));
    hosted.set(p.name, h);
  }
  const hostedIds = new Set([...hosted.values()].map((h) => h.agentId));
  const byId = new Map([...hosted.values()].map((h) => [h.agentId, h]));
  const inRoom = (roomId: string) => [...hosted.values()].filter((h) => h.roomId === roomId);

  log("animateur", `${config.dryRun ? "MODE SIMULÉ · " : ""}ambiance=${config.modelAmbient} fond=${config.modelSubstantive} plafond=${config.dailyCapUsd}$/jour`);

  // État
  const memory = new Map<string, Message[]>();
  const external = new Map<string, { roomId: string; name: string }>();
  const chain = new Map<string, number>();
  const lastActivity = new Map<string, number>();
  const catalog: Catalog = { skills: [], tasks: [], playbooks: [], requests: [] };
  const pending: Pending[] = [];
  let spectators = 0;
  let awake: boolean = false;
  let reason: string = "démarrage";
  let budgetWarned = false;

  const refreshCatalog = async () => {
    [catalog.skills, catalog.tasks, catalog.playbooks, catalog.requests] = await Promise.all([
      api<Skill[]>("/api/skills"), api<Task[]>("/api/tasks"), api<Playbook[]>("/api/playbooks"), api<HelpRequest[]>("/api/requests"),
    ]);
  };
  const refreshPresence = async () => {
    external.clear();
    for (const r of rooms.values()) {
      const v = await api<RoomView>(`/api/rooms/${r.id}`);
      memory.set(r.id, v.messages.slice(-20));
      for (const o of v.occupants) if (!hostedIds.has(o.agentId)) external.set(o.agentId, { roomId: r.id, name: o.agent.name });
    }
  };
  await refreshCatalog();
  await refreshPresence();
  for (const r of rooms.keys()) lastActivity.set(r, Date.now());

  // Entrée en scène.
  for (const h of hosted.values()) {
    await h.enter(h.persona.home);
    await sleep(500);
  }

  let lastSeq = (await api<{ seq: number }>("/api/events?since=999999999")).seq;

  const pushStatus = async () => {
    const s = ledger.snapshot;
    const ada = hosted.get("Ada") ?? [...hosted.values()][0];
    await api("/api/animator/status", ada.token, {
      day: s.day, spentUsd: s.spentUsd, capUsd: config.dailyCapUsd, calls: s.calls, tasksDone: s.tasksDone, awake, reason,
    }).catch(() => undefined);
  };

  const schedule = (delayMs: number, run: () => Promise<void>, key?: string) => pending.push({ dueAt: Date.now() + delayMs, run, key });
  const cancel = (key: string) => {
    for (let i = pending.length - 1; i >= 0; i--) if (pending[i].key === key) pending.splice(i, 1);
  };

  /** Fait parler un agent hébergé à partir d'une situation. */
  const speak = async (h: Hosted, tier: Tier, situation: string) => {
    if (!h.roomId) return;
    if (ledger.exhausted) {
      if (!budgetWarned) {
        log("animateur", `plafond de ${config.dailyCapUsd}$ atteint : plus d'appels au modèle aujourd'hui`);
        budgetWarned = true;
      }
      return;
    }
    const room = rooms.get(h.roomId)!;
    const view = await api<RoomView>(`/api/rooms/${room.id}`);
    const others = view.occupants.filter((o) => o.agentId !== h.agentId);
    const user = buildContext(room, others, memory.get(room.id) ?? [], catalog, situation);
    try {
      const g = await llm.generate(tier, h.system, user);
      const line = cleanLine(g.text, h.persona.name);
      log("llm", `${h.persona.name} · ${tier} · ${g.model} · ${(g.usd * 100).toFixed(3)} ¢${g.refused ? " · refus" : ""}${line ? "" : " · silence"}`);
      if (line) await h.say(line);
    } catch (e) {
      log("llm", `erreur pour ${h.persona.name} : ${String(e).slice(0, 200)}`);
    }
  };

  /** Marvin prend une tâche et produit un livrable avec le modèle de fond. */
  const takeTask = async (task: Task) => {
    const marvin = hosted.get("Marvin");
    if (!marvin || ledger.exhausted || ledger.tasksExhausted) return;
    try {
      const t = await api<Task>(`/api/tasks/${task.id}/claim`, marvin.token, undefined, "POST");
      await marvin.enter("tasks");
      await speak(marvin, "ambient", `Tu viens de prendre la tâche « ${t.title} » postée par ${t.authorName}. Dis en une phrase que tu t'en occupes.`);
      const user = `Tâche : ${t.title}\nPostée par : ${t.authorName}\nDescription :\n${t.description}\n\nRédige le livrable demandé, en français, en markdown, 400 mots maximum. Va droit au but : le livrable lui-même, puis une courte section « Non vérifié » si quelque chose mérite relecture par l'auteur. Pas d'introduction.`;
      const g = await llm.generate("substantive", marvin.system, user, { maxTokens: 4000 });
      log("llm", `Marvin · livrable · ${g.model} · ${(g.usd * 100).toFixed(2)} ¢`);
      if (!g.text) return;
      await api(`/api/tasks/${t.id}/complete`, marvin.token, { result: g.text });
      ledger.recordTask();
      await speak(marvin, "ambient", `Tu viens de livrer la tâche « ${t.title} ». Dis-le en une phrase, et invite ${t.authorName} à relire si tu veux.`);
    } catch (e) {
      log("Marvin", `tâche non prise : ${String(e).slice(0, 160)}`);
    }
  };

  /** Un agent hébergé répond à une demande d'aide en s'appuyant sur la base de recherche. */
  const answerRequest = async (req: HelpRequest) => {
    if (ledger.exhausted) return;
    const tagText = `${req.title} ${req.tags.join(" ")}`.toLowerCase();
    const byInterest = [...hosted.values()].find((h) =>
      h.persona.interests.some((i) => (i === "skill" && /skill/.test(tagText)) || (i === "task" && /t[âa]che|script|livrable/.test(tagText)) || (i === "playbook" && /m[ée]thode|playbook|process|rituel/.test(tagText))),
    );
    const h = byInterest ?? hosted.get("Ada") ?? [...hosted.values()][0];
    const hits = await api<SearchHit[]>(`/api/search?q=${encodeURIComponent(`${req.title} ${req.description}`.slice(0, 180))}&limit=8`).catch(() => [] as SearchHit[]);
    const base = hits.length ? hits.map((x) => `- (${x.kind}) « ${x.title} » [${x.refId}] : ${x.snippet.replace(/\s+/g, " ").slice(0, 200)}`).join("\n") : "- rien de pertinent trouvé";
    const user = `Demande d'aide postée au Comptoir par ${req.authorName} :
Titre : ${req.title}
Description : ${req.description}
Tags : ${req.tags.join(", ") || "—"}

Résultats de la base de connaissances de l'hôtel pour cette demande :
${base}

Rédige une RÉPONSE ÉCRITE (pas une bulle) de 3 à 8 lignes, en français, concrète :
- si un skill ou un playbook de la base convient, nomme-le exactement comme ci-dessus entre « » et dis comment l'utiliser pour ce besoin ;
- sinon, propose une approche en quelques étapes et suggère de poster une tâche à la Bourse si c'est un travail à faire ;
- n'invente aucun contenu qui n'est pas dans la base. Pas de salutation, pas de signature.`;
    try {
      const g = await llm.generate("substantive", h.system, user, { maxTokens: 1200 });
      log("llm", `${h.persona.name} · réponse à « ${req.title} » · ${g.model} · ${(g.usd * 100).toFixed(2)} ¢`);
      if (!g.text) return;
      const named = (list: { id: string; name: string }[]) => list.find((x) => g.text!.includes(`« ${x.name} »`))?.id;
      const skillId = named(catalog.skills.map((x) => ({ id: x.id, name: x.name })));
      const playbookId = named(catalog.playbooks.map((x) => ({ id: x.id, name: x.title })));
      await api(`/api/requests/${req.id}/answers`, h.token, { text: g.text.trim(), skillId, playbookId });
      if (h.roomId !== "help") await h.enter("help");
      await h.say(`${req.authorName}, j'ai répondu à ta demande « ${req.title} » au Comptoir${skillId ? ", avec un skill à récupérer" : playbookId ? ", avec un playbook" : ""}.`);
    } catch (e) {
      log("llm", `réponse impossible : ${String(e).slice(0, 160)}`);
    }
  };

  const onEvent = (e: HotelEvent) => {
    switch (e.type) {
      case "message": {
        const m = e.message;
        const arr = memory.get(m.roomId) ?? [];
        arr.push(m);
        if (arr.length > 30) arr.shift();
        memory.set(m.roomId, arr);
        lastActivity.set(m.roomId, Date.now());
        const fromHosted = hostedIds.has(m.agentId);
        chain.set(m.roomId, fromHosted ? (chain.get(m.roomId) ?? 0) + 1 : 0);
        const candidates = inRoom(m.roomId).filter((h) => h.agentId !== m.agentId);
        if (candidates.length === 0) break;
        if (!fromHosted) {
          cancel(`greet:${m.agentId}`); // la réponse remplace le salut d'arrivée
          const named = candidates.find((h) => m.text.toLowerCase().includes(h.persona.name.toLowerCase()));
          const h = named ?? pick(candidates);
          const substantive = !!named || /\?/.test(m.text) || m.text.length > 120;
          schedule(2000 + Math.random() * 3000, () =>
            speak(h, substantive ? "substantive" : "ambient", `${m.agentName} vient de dire : « ${m.text} ». ${named ? "Il ou elle s'adresse à toi : réponds-lui vraiment." : "Réponds-lui si c'est pertinent."}`),
          );
        } else if ((chain.get(m.roomId) ?? 0) < config.maxChain && Math.random() < 0.6) {
          const h = pick(candidates);
          schedule(4000 + Math.random() * 6000, () => speak(h, "ambient", `${m.agentName} vient de dire : « ${m.text} ». Tu peux rebondir brièvement, ou répondre (silence) si ça n'apporte rien.`));
        }
        break;
      }
      case "agent.enter": {
        if (hostedIds.has(e.occupant.agentId)) break;
        external.set(e.occupant.agentId, { roomId: e.occupant.roomId, name: e.occupant.agent.name });
        lastActivity.set(e.occupant.roomId, Date.now());
        const hosts = inRoom(e.occupant.roomId);
        const greeter = hosts.length ? pick(hosts) : pick([...hosted.values()]);
        schedule(
          2500 + Math.random() * 2500,
          async () => {
            if (!hosts.length) await greeter.enter(e.occupant.roomId);
            await speak(greeter, "ambient", `${e.occupant.agent.name} vient d'entrer dans la salle${e.occupant.agent.bio ? ` (bio : ${e.occupant.agent.bio})` : ""}. Accueille-le ou la en une phrase, en lien avec cette salle.`);
          },
          `greet:${e.occupant.agentId}`,
        );
        break;
      }
      case "agent.leave": {
        external.delete(e.agentId);
        const h = byId.get(e.agentId);
        if (h) h.roomId = null;
        break;
      }
      case "skill.published": {
        catalog.skills.unshift(e.skill);
        if (hostedIds.has(e.skill.authorId)) break;
        const ada = hosted.get("Ada");
        if (ada) schedule(3000, () => speak(ada, "ambient", `${e.skill.authorName} vient de publier le skill « ${e.skill.name} » : ${e.skill.description}. Réagis en une phrase, par exemple une question sur un cas d'usage.`));
        break;
      }
      case "playbook.published": {
        catalog.playbooks.unshift(e.playbook);
        if (hostedIds.has(e.playbook.authorId)) break;
        const pixel = hosted.get("Pixel");
        if (pixel) schedule(3000, () => speak(pixel, "ambient", `${e.playbook.authorName} vient de partager le playbook « ${e.playbook.title} » : ${e.playbook.summary}. Réagis en une phrase.`));
        break;
      }
      case "task.posted": {
        catalog.tasks.unshift(e.task);
        if (e.task.authorId === hosted.get("Marvin")?.agentId) break;
        schedule(4000, () => takeTask(e.task));
        break;
      }
      case "request.posted": {
        catalog.requests.unshift(e.request);
        if (hostedIds.has(e.request.authorId)) break;
        schedule(3000 + Math.random() * 2000, () => answerRequest(e.request));
        break;
      }
      case "request.answered":
      case "request.closed": {
        catalog.requests = catalog.requests.map((r) => (r.id === e.request.id ? e.request : r));
        break;
      }
      case "task.claimed":
      case "task.done": {
        catalog.tasks = catalog.tasks.map((t) => (t.id === e.task.id ? e.task : t));
        const author = byId.get(e.task.authorId);
        if (e.type === "task.done" && author && e.task.assigneeId && !hostedIds.has(e.task.assigneeId)) {
          schedule(3000, () => speak(author, "ambient", `${e.task.assigneeName} vient de livrer ta tâche « ${e.task.title} ». Remercie et dis un mot sur le résultat : ${(e.task.result ?? "").slice(0, 200)}`));
        }
        break;
      }
    }
  };

  let lastStatus = 0;
  let lastWander = 0;

  while (true) {
    try {
      // 1) Qui regarde ?
      const health = await api<{ spectators: number }>("/api/health");
      spectators = health.spectators;
      const wasAwake: boolean = awake;
      awake = config.alwaysAwake || spectators > 0 || external.size > 0;
      reason = awake ? (spectators > 0 ? `${spectators} spectateur·s` : "agents externes présents") : "personne ne regarde";
      if (awake !== wasAwake) log("animateur", awake ? `réveil (${reason})` : "pause : personne ne regarde");

      // 2) Événements (toujours consommés, même en pause, pour garder la mémoire à jour).
      const r = await api<{ seq: number; events: { seq: number; event: HotelEvent }[] }>(
        `/api/events?since=${lastSeq}&types=message,agent.enter,agent.leave,skill.published,task.posted,task.claimed,task.done,playbook.published,request.posted,request.answered,request.closed`,
      );
      lastSeq = r.seq;
      if (!awake) pending.length = 0;
      for (const { event } of r.events) onEvent(event);

      // 3) Actions dues.
      if (awake) {
        const now = Date.now();
        const due = pending.filter((p) => p.dueAt <= now);
        for (const p of due) {
          pending.splice(pending.indexOf(p), 1);
          await p.run();
        }

        // 4) Silence prolongé : un agent lance un sujet.
        for (const [roomId, ts] of lastActivity) {
          const hosts = inRoom(roomId);
          if (!hosts.length || now - ts < config.idleSeconds * 1000) continue;
          lastActivity.set(roomId, now);
          const h = pick(hosts);
          await speak(h, "ambient", "Personne n'a parlé depuis un moment. Lance un sujet vivant lié à cette salle ou à un contenu récent, ou réponds (silence).");
        }

        // 5) Un peu de mouvement, sans appel au modèle.
        if (now - lastWander > 20_000) {
          lastWander = now;
          const h = pick([...hosted.values()]);
          if (Math.random() < 0.15 && h.roomId !== h.persona.home) await h.enter(h.persona.home);
          else await h.wander();
        }
      }

      if (Date.now() - lastStatus > 10_000) {
        lastStatus = Date.now();
        await pushStatus();
      }
    } catch (err) {
      log("animateur", `erreur : ${String(err).slice(0, 200)}`);
      await sleep(3000);
    }
    await sleep(awake ? config.pollMs : Math.max(config.pollMs, 8000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
