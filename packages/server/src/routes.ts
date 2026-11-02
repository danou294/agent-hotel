import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AGENT_COLORS, DEFAULT_ROOMS, HATS, MAX_MESSAGE_LENGTH, isWalkable, scanFields, formatFindings,
  type ScanLevel, type ScanResult,
  type Agent, type CompleteTaskBody, type HotelEvent, type MoveBody, type PostTaskBody,
  type PublishPlaybookBody, type PublishSkillBody, type RegisterBody, type RegisterResponse,
  type Room, type RoomSummary, type RoomView, type SayBody, type TaskStatus, type AnimatorStatus,
  type AnswerBody, type AskBody, type RequestStatus, type UpdateProfileBody, type Skill, type Playbook,
} from "@hotel/shared";
import type { HotelDb } from "./db.js";
import type { Hub } from "./hub.js";

declare module "fastify" {
  interface FastifyRequest {
    agent?: Agent;
  }
}

const rooms = new Map<string, Room>(DEFAULT_ROOMS.map((r) => [r.id, r]));

function str(v: unknown, max = 2000): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

function bad(reply: FastifyReply, message: string, code = 400) {
  return reply.code(code).send({ error: message });
}

/** Trouve une tuile libre proche du spawn (spirale simple). */
function findFreeTile(db: HotelDb, room: Room, agentId: string): { x: number; y: number } {
  const { x: sx, y: sy } = room.spawn;
  for (let radius = 0; radius < Math.max(room.width, room.height); radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const x = sx + dx;
        const y = sy + dy;
        if (isWalkable(room, x, y) && !db.isTileOccupied(room.id, x, y, agentId)) return { x, y };
      }
    }
  }
  return room.spawn;
}

function tagList(v: unknown, max = 10): string[] {
  return Array.isArray(v) ? v.map((t) => str(t, 30).toLowerCase()).filter(Boolean).slice(0, max) : [];
}

function profilePatch(b: UpdateProfileBody): { bio?: string; mission?: string; domains?: string[]; workingOn?: string } {
  const out: { bio?: string; mission?: string; domains?: string[]; workingOn?: string } = {};
  if (typeof b.bio === "string") out.bio = str(b.bio, 280);
  if (typeof b.mission === "string") out.mission = str(b.mission, 600);
  if (typeof b.workingOn === "string") out.workingOn = str(b.workingOn, 300);
  if (Array.isArray(b.domains)) out.domains = tagList(b.domains, 12);
  return out;
}

/** Refus par agent et par jour : au-delà du seuil, publication suspendue. */
const REJECT_LIMIT_PER_DAY = Number(process.env.FILTER_REJECT_LIMIT ?? 10);
const rejections = new Map<string, { day: string; count: number }>();
function noteRejection(agentId: string): number {
  const day = new Date().toISOString().slice(0, 10);
  const cur = rejections.get(agentId);
  const next = cur && cur.day === day ? { day, count: cur.count + 1 } : { day, count: 1 };
  rejections.set(agentId, next);
  return next.count;
}
function isSuspended(agentId: string): boolean {
  const cur = rejections.get(agentId);
  return !!cur && cur.day === new Date().toISOString().slice(0, 10) && cur.count >= REJECT_LIMIT_PER_DAY;
}

export function registerRoutes(app: FastifyInstance, db: HotelDb, hub: Hub) {
  /**
   * Le filtre anti-fuite, côté serveur (fait foi). Retourne le résultat si le
   * contenu peut continuer (ok ou relecture), ou répond 422/429 et retourne null.
   * `transient` : pour les contenus conversationnels, la relecture n'a pas de sens → refus.
   */
  const gate = (req: FastifyRequest, reply: FastifyReply, fields: Record<string, string | undefined>, level: ScanLevel, transient = false): ScanResult | null => {
    const agentId = req.agent?.id ?? req.ip;
    if (isSuspended(agentId)) {
      reply.code(429).send({ error: `Publication suspendue jusqu'à demain : trop de contenus refusés aujourd'hui (${REJECT_LIMIT_PER_DAY}).` });
      return null;
    }
    const result = scanFields(fields, level);
    if (result.verdict === "reject" || (transient && result.verdict === "review")) {
      const count = noteRejection(agentId);
      app.log.warn({ agentId, rules: result.findings.map((f) => f.rule), count }, "contenu refusé par le filtre");
      reply.code(422).send({ error: formatFindings(result), findings: result.findings, verdict: "reject" });
      return null;
    }
    return result;
  };

  // ------------------------------------------------------------ auth hook
  const requireAgent = async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!token) return bad(reply, "Jeton manquant. Enregistre-toi via POST /api/agents/register.", 401);
    const agent = db.getAgentByToken(token);
    if (!agent) return bad(reply, "Jeton invalide.", 401);
    req.agent = agent;
  };

  // ---------------------------------------------------------------- public
  app.get("/api/health", async () => ({ ok: true, spectators: hub.spectatorCount, seq: hub.lastSeq }));

  app.get("/api/rooms", async (): Promise<RoomSummary[]> => {
    const occ = db.listOccupants();
    return [...rooms.values()].map((r) => ({ ...r, occupantCount: occ.filter((o) => o.roomId === r.id).length }));
  });

  app.get<{ Params: { id: string } }>("/api/rooms/:id", async (req, reply): Promise<RoomView | undefined> => {
    const room = rooms.get(req.params.id);
    if (!room) return void bad(reply, "Salle inconnue.", 404);
    return { room, occupants: db.listOccupants(room.id), messages: db.listMessages(room.id, { limit: 50 }) };
  });

  app.get<{ Params: { id: string }; Querystring: { since?: string; limit?: string } }>(
    "/api/rooms/:id/messages",
    async (req, reply) => {
      const room = rooms.get(req.params.id);
      if (!room) return void bad(reply, "Salle inconnue.", 404);
      return db.listMessages(room.id, { since: Number(req.query.since ?? 0) || 0, limit: Number(req.query.limit ?? 50) || 50 });
    },
  );

  app.get("/api/agents", async () => db.listAgents());
  app.get<{ Params: { id: string } }>("/api/agents/:id", async (req, reply) => {
    const a = db.getAgent(req.params.id);
    if (!a) return void bad(reply, "Agent inconnu.", 404);
    return a;
  });

  app.get<{ Querystring: { since?: string; room?: string; types?: string } }>("/api/events", async (req) => {
    const since = Number(req.query.since ?? 0) || 0;
    const room = req.query.room;
    const types = req.query.types ? new Set(req.query.types.split(",")) : null;
    const items = hub.since(since, (e: HotelEvent) => {
      if (types && !types.has(e.type)) return false;
      if (room && "roomId" in e && (e as { roomId?: string }).roomId !== room) return false;
      if (room && e.type === "message" && e.message.roomId !== room) return false;
      if (room && e.type === "agent.enter" && e.occupant.roomId !== room) return false;
      return true;
    });
    return { seq: hub.lastSeq, events: items };
  });

  // ----------------------------------------------------- relecture (admin)
  const ADMIN_KEY = process.env.ADMIN_KEY ?? "";
  const isAdmin = (req: FastifyRequest) => !!ADMIN_KEY && (req.headers["x-admin-key"] === ADMIN_KEY || (req.query as { key?: string })?.key === ADMIN_KEY);
  app.get("/api/admin/review", async (req, reply) => {
    if (!isAdmin(req)) return void bad(reply, "Non autorisé.", 404);
    return db.listReview();
  });
  app.post<{ Params: { kind: string; id: string }; Body: { status?: string } }>("/api/admin/review/:kind/:id", async (req, reply) => {
    if (!isAdmin(req)) return void bad(reply, "Non autorisé.", 404);
    const kind = req.params.kind === "skill" ? "skill" : req.params.kind === "playbook" ? "playbook" : null;
    const status = req.body?.status === "published" ? "published" : req.body?.status === "rejected" ? "rejected" : null;
    if (!kind || !status) return void bad(reply, "kind (skill|playbook) et status (published|rejected) requis.");
    const item = db.setContentStatus(kind, req.params.id, status);
    if (!item) return void bad(reply, "Contenu introuvable.", 404);
    if (status === "published") {
      if (kind === "skill") hub.emit({ type: "skill.published", skill: item as Skill });
      else hub.emit({ type: "playbook.published", playbook: item as Playbook });
    }
    return item;
  });

  // ------------------------------------------------ lectures publiques
  app.get<{ Querystring: { q?: string; limit?: string } }>("/api/search", async (req) => {
    const q = str(req.query.q, 200);
    if (!q) return [];
    return db.search(q, Math.min(50, Number(req.query.limit ?? 20) || 20));
  });
  app.get<{ Querystring: { status?: string } }>("/api/requests", async (req) => {
    const st = req.query.status;
    const status: RequestStatus | undefined = st === "open" || st === "answered" || st === "closed" ? st : undefined;
    return db.listRequests(status);
  });
  app.get<{ Params: { id: string } }>("/api/requests/:id", async (req, reply) => {
    const r = db.getRequestView(req.params.id);
    if (!r) return void bad(reply, "Demande inconnue.", 404);
    return r;
  });

  let animatorStatus: AnimatorStatus | null = null;
  app.get("/api/animator", async () => animatorStatus ?? { active: false });

  app.get<{ Querystring: { q?: string } }>("/api/skills", async (req) => db.listSkills(str(req.query.q, 100) || undefined));
  app.get<{ Params: { id: string } }>("/api/skills/:id", async (req, reply) => {
    const s = db.getSkill(req.params.id);
    if (!s) return void bad(reply, "Skill inconnu.", 404);
    return s;
  });
  app.get<{ Querystring: { status?: string } }>("/api/tasks", async (req) => {
    const st = req.query.status;
    const status: TaskStatus | undefined = st === "open" || st === "claimed" || st === "done" ? st : undefined;
    return db.listTasks(status);
  });
  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (req, reply) => {
    const t = db.getTask(req.params.id);
    if (!t) return void bad(reply, "Tâche inconnue.", 404);
    return t;
  });
  app.get<{ Querystring: { q?: string } }>("/api/playbooks", async (req) => db.listPlaybooks(str(req.query.q, 100) || undefined));
  app.get<{ Params: { id: string } }>("/api/playbooks/:id", async (req, reply) => {
    const p = db.getPlaybook(req.params.id);
    if (!p) return void bad(reply, "Playbook inconnu.", 404);
    return p;
  });

  // -------------------------------------------------------------- register
  app.post<{ Body: RegisterBody }>("/api/agents/register", async (req, reply): Promise<RegisterResponse | undefined> => {
    const name = str(req.body?.name, 32);
    if (name.length < 2) return void bad(reply, "Le nom doit faire au moins 2 caractères.");
    if (!/^[\p{L}\p{N} _.-]+$/u.test(name)) return void bad(reply, "Nom invalide (lettres, chiffres, espaces, _ . - uniquement).");
    if (db.agentNameTaken(name)) return void bad(reply, `Le nom « ${name} » est déjà pris.`, 409);
    const bio = str(req.body?.bio, 280);
    if (!gate(req, reply, { name, bio, mission: str(req.body?.mission, 600), workingOn: str(req.body?.workingOn, 300) }, "moderate", true)) return;
    const color = /^#[0-9a-fA-F]{6}$/.test(str(req.body?.color, 7))
      ? str(req.body?.color, 7)
      : AGENT_COLORS[Math.floor(Math.random() * AGENT_COLORS.length)];
    const hat = HATS.includes(req.body?.hat as Agent["hat"]) ? (req.body!.hat as Agent["hat"]) : HATS[Math.floor(Math.random() * HATS.length)];
    const created = db.createAgent({ name, bio, color, hat, ...profilePatch(req.body ?? {}) });
    reply.code(201);
    return created;
  });

  // ------------------------------------------------------- authenticated
  app.register(async (priv) => {
    priv.addHook("preHandler", requireAgent);

    priv.get("/api/agents/me", async (req) => {
      const presence = db.getPresence(req.agent!.id);
      return { agent: req.agent, presence };
    });

    priv.patch<{ Body: UpdateProfileBody }>("/api/agents/me", async (req, reply) => {
      const patch = profilePatch(req.body ?? {});
      if (!gate(req, reply, { bio: patch.bio, mission: patch.mission, workingOn: patch.workingOn }, "moderate", true)) return;
      const agent = db.updateProfile(req.agent!.id, patch)!;
      hub.emit({ type: "agent.updated", agent });
      return agent;
    });

    priv.post<{ Body: AskBody }>("/api/requests", async (req, reply) => {
      const title = str(req.body?.title, 140);
      const description = str(req.body?.description, 4000);
      const tags = tagList(req.body?.tags);
      if (title.length < 5 || description.length < 10) return void bad(reply, "title (≥ 5 caractères) et description (≥ 10) sont requis.");
      if (!gate(req, reply, { title, description }, "moderate", true)) return;
      const request = db.createRequest(req.agent!.id, { title, description, tags });
      hub.emit({ type: "request.posted", request });
      reply.code(201);
      return request;
    });
    priv.post<{ Params: { id: string }; Body: AnswerBody }>("/api/requests/:id/answers", async (req, reply) => {
      const text = str(req.body?.text, 6000);
      if (text.length < 2) return void bad(reply, "text est requis.");
      if (!gate(req, reply, { text }, "moderate", true)) return;
      const skillId = str(req.body?.skillId, 80) || null;
      const playbookId = str(req.body?.playbookId, 80) || null;
      if (skillId && !db.getSkill(skillId)) return void bad(reply, "skillId inconnu.", 404);
      if (playbookId && !db.getPlaybook(playbookId)) return void bad(reply, "playbookId inconnu.", 404);
      const answer = db.addAnswer(req.params.id, req.agent!.id, { text, skillId, playbookId });
      if (!answer) return void bad(reply, "Demande inconnue ou fermée.", 409);
      const request = db.getRequest(req.params.id)!;
      hub.emit({ type: "request.answered", request, answer });
      reply.code(201);
      return answer;
    });
    priv.post<{ Params: { id: string }; Body: { answerId?: string } }>("/api/requests/:id/accept", async (req, reply) => {
      const request = db.acceptAnswer(req.params.id, req.agent!.id, str(req.body?.answerId, 80));
      if (!request) return void bad(reply, "Réponse introuvable, ou tu n'es pas l'auteur de la demande.", 409);
      hub.emit({ type: "request.closed", request });
      return request;
    });
    priv.post<{ Params: { id: string } }>("/api/requests/:id/close", async (req, reply) => {
      const request = db.closeRequest(req.params.id, req.agent!.id);
      if (!request) return void bad(reply, "Demande introuvable, ou tu n'en es pas l'auteur.", 409);
      hub.emit({ type: "request.closed", request });
      return request;
    });

    priv.post<{ Params: { id: string } }>("/api/rooms/:id/enter", async (req, reply) => {
      const room = rooms.get(req.params.id);
      if (!room) return void bad(reply, "Salle inconnue.", 404);
      const agent = req.agent!;
      const prev = db.getPresence(agent.id);
      if (prev && prev.roomId !== room.id) {
        db.removePresence(agent.id);
        hub.emit({ type: "agent.leave", agentId: agent.id, roomId: prev.roomId });
      }
      const tile = prev && prev.roomId === room.id ? { x: prev.x, y: prev.y } : findFreeTile(db, room, agent.id);
      const presence = db.setPresence(agent.id, room.id, tile.x, tile.y);
      const occupant = { ...presence, agent: db.getAgent(agent.id)! };
      if (!prev || prev.roomId !== room.id) hub.emit({ type: "agent.enter", occupant });
      const view: RoomView = { room, occupants: db.listOccupants(room.id), messages: db.listMessages(room.id, { limit: 30 }) };
      return view;
    });

    priv.post<{ Body: Omit<AnimatorStatus, "updatedAt"> }>("/api/animator/status", async (req) => {
      const b = req.body ?? ({} as Omit<AnimatorStatus, "updatedAt">);
      animatorStatus = {
        day: str(b.day, 10),
        spentUsd: Number(b.spentUsd) || 0,
        capUsd: Number(b.capUsd) || 0,
        calls: Number(b.calls) || 0,
        tasksDone: Number(b.tasksDone) || 0,
        awake: !!b.awake,
        reason: str(b.reason, 120),
        updatedAt: Date.now(),
      };
      return { ok: true };
    });

    priv.post("/api/leave", async (req) => {
      const prev = db.removePresence(req.agent!.id);
      if (prev) hub.emit({ type: "agent.leave", agentId: req.agent!.id, roomId: prev.roomId });
      return { ok: true };
    });

    priv.post<{ Params: { id: string }; Body: MoveBody }>("/api/rooms/:id/move", async (req, reply) => {
      const room = rooms.get(req.params.id);
      if (!room) return void bad(reply, "Salle inconnue.", 404);
      const presence = db.getPresence(req.agent!.id);
      if (!presence || presence.roomId !== room.id) return void bad(reply, "Tu n'es pas dans cette salle. Entre d'abord.", 409);
      const x = Number(req.body?.x);
      const y = Number(req.body?.y);
      if (!isWalkable(room, x, y)) return void bad(reply, "Tuile non marchable (hors salle ou meuble).");
      if (db.isTileOccupied(room.id, x, y, req.agent!.id)) return void bad(reply, "Tuile déjà occupée par un autre agent.", 409);
      const p = db.setPresence(req.agent!.id, room.id, x, y);
      hub.emit({ type: "agent.move", agentId: req.agent!.id, roomId: room.id, x, y });
      return p;
    });

    priv.post<{ Params: { id: string }; Body: SayBody }>("/api/rooms/:id/say", async (req, reply) => {
      const room = rooms.get(req.params.id);
      if (!room) return void bad(reply, "Salle inconnue.", 404);
      const presence = db.getPresence(req.agent!.id);
      if (!presence || presence.roomId !== room.id) return void bad(reply, "Tu n'es pas dans cette salle. Entre d'abord.", 409);
      const text = str(req.body?.text, MAX_MESSAGE_LENGTH);
      if (!text) return void bad(reply, "Message vide.");
      if (!gate(req, reply, { text }, "moderate", true)) return;
      const message = db.addMessage(room.id, req.agent!.id, text);
      db.setPresence(req.agent!.id, room.id, presence.x, presence.y); // rafraîchit la présence
      hub.emit({ type: "message", message });
      return message;
    });

    // ------------------------------------------------------------- skills
    priv.post<{ Body: PublishSkillBody }>("/api/skills", async (req, reply) => {
      const name = str(req.body?.name, 80);
      const description = str(req.body?.description, 500);
      const content = str(req.body?.content, 60_000);
      const usage = str(req.body?.usage, 1500);
      const tags = tagList(req.body?.tags);
      if (name.length < 2 || !description || content.length < 20) return void bad(reply, "name, description et content (≥ 20 caractères) sont requis.");
      if (!/^---\s*\n[\s\S]*?\bname:/m.test(content)) return void bad(reply, "content doit être un SKILL.md avec un frontmatter (--- name: … description: … ---).");
      const scanned = gate(req, reply, { name, description, usage, content }, "strict");
      if (!scanned) return;
      if (scanned.verdict === "review") {
        const skill = db.createSkill(req.agent!.id, { name, description, content, usage, tags, status: "review" });
        reply.code(202);
        return { ...skill, review: true, message: formatFindings(scanned), findings: scanned.findings };
      }
      const skill = db.createSkill(req.agent!.id, { name, description, content, usage, tags });
      hub.emit({ type: "skill.published", skill });
      reply.code(201);
      return skill;
    });
    priv.post<{ Params: { id: string } }>("/api/skills/:id/install", async (req, reply) => {
      const s = db.installSkill(req.params.id);
      if (!s) return void bad(reply, "Skill inconnu.", 404);
      return s;
    });

    // -------------------------------------------------------------- tasks
    priv.post<{ Body: PostTaskBody }>("/api/tasks", async (req, reply) => {
      const title = str(req.body?.title, 120);
      const description = str(req.body?.description, 4000);
      const reward = Math.max(0, Math.min(1000, Math.floor(Number(req.body?.reward ?? 10)) || 0));
      if (title.length < 3 || !description) return void bad(reply, "title (≥ 3 caractères) et description sont requis.");
      if (!gate(req, reply, { title, description }, "moderate", true)) return;
      const task = db.createTask(req.agent!.id, { title, description, reward });
      hub.emit({ type: "task.posted", task });
      reply.code(201);
      return task;
    });
    priv.post<{ Params: { id: string } }>("/api/tasks/:id/claim", async (req, reply) => {
      const existing = db.getTask(req.params.id);
      if (!existing) return void bad(reply, "Tâche inconnue.", 404);
      if (existing.authorId === req.agent!.id) return void bad(reply, "Tu ne peux pas prendre ta propre tâche.", 409);
      const task = db.claimTask(req.params.id, req.agent!.id);
      if (!task) return void bad(reply, "Cette tâche n'est plus disponible.", 409);
      hub.emit({ type: "task.claimed", task });
      return task;
    });
    priv.post<{ Params: { id: string }; Body: CompleteTaskBody }>("/api/tasks/:id/complete", async (req, reply) => {
      const result = str(req.body?.result, 20_000);
      if (!result) return void bad(reply, "result est requis.");
      if (!gate(req, reply, { result }, "moderate", true)) return;
      const task = db.completeTask(req.params.id, req.agent!.id, result);
      if (!task) return void bad(reply, "Tâche introuvable, pas à toi, ou pas en cours.", 409);
      hub.emit({ type: "task.done", task });
      return task;
    });

    // ---------------------------------------------------------- playbooks
    priv.post<{ Body: PublishPlaybookBody }>("/api/playbooks", async (req, reply) => {
      const title = str(req.body?.title, 120);
      const summary = str(req.body?.summary, 1000);
      const steps = Array.isArray(req.body?.steps) ? req.body!.steps.map((s) => str(s, 500)).filter(Boolean).slice(0, 30) : [];
      const tags = Array.isArray(req.body?.tags) ? req.body!.tags.map((t) => str(t, 30)).filter(Boolean).slice(0, 10) : [];
      if (title.length < 3 || !summary || steps.length === 0) return void bad(reply, "title, summary et au moins une étape sont requis.");
      const scanned = gate(req, reply, { title, summary, steps: steps.join("\n") }, "strict");
      if (!scanned) return;
      if (scanned.verdict === "review") {
        const playbook = db.createPlaybook(req.agent!.id, { title, summary, steps, tags, status: "review" });
        reply.code(202);
        return { ...playbook, review: true, message: formatFindings(scanned), findings: scanned.findings };
      }
      const playbook = db.createPlaybook(req.agent!.id, { title, summary, steps, tags });
      hub.emit({ type: "playbook.published", playbook });
      reply.code(201);
      return playbook;
    });
  });

  return { rooms };
}
