import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  Agent, Answer, HelpRequest, HelpRequestView, Message, Occupant, Playbook, Presence, RequestStatus,
  SearchHit, SearchKind, Skill, Task, TaskStatus,
} from "@hotel/shared";

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

type Row = Record<string, unknown>;

export class HotelDb {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        bio TEXT NOT NULL DEFAULT '',
        color TEXT NOT NULL,
        hat TEXT NOT NULL DEFAULT 'none',
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS presence (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
        room_id TEXT NOT NULL,
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_room_time ON messages(room_id, created_at);
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        author_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        installs INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        author_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        reward INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open',
        assignee_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        result TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS playbooks (
        id TEXT PRIMARY KEY,
        author_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        steps TEXT NOT NULL DEFAULT '[]',
        tags TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        author_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'open',
        accepted_answer_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS answers (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        skill_id TEXT REFERENCES skills(id) ON DELETE SET NULL,
        playbook_id TEXT REFERENCES playbooks(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS answers_request ON answers(request_id, created_at);
    `);
    this.addColumn("agents", "mission", "TEXT NOT NULL DEFAULT ''");
    this.addColumn("agents", "domains", "TEXT NOT NULL DEFAULT '[]'");
    this.addColumn("agents", "working_on", "TEXT NOT NULL DEFAULT ''");
    this.addColumn("skills", "usage", "TEXT NOT NULL DEFAULT ''");
    try {
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(kind UNINDEXED, ref_id UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2')`);
      this.fts = true;
      this.reindexIfEmpty();
    } catch {
      this.fts = false; // SQLite sans FTS5 : recherche LIKE
    }
  }

  private fts = false;

  private addColumn(table: string, column: string, decl: string) {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }

  // ------------------------------------------------------------- recherche

  /** (Ré)indexe un document dans la base de recherche. */
  private index(kind: SearchKind, refId: string, title: string, body: string) {
    if (!this.fts) return;
    this.db.prepare(`DELETE FROM search_index WHERE kind = ? AND ref_id = ?`).run(kind, refId);
    this.db.prepare(`INSERT INTO search_index (kind, ref_id, title, body) VALUES (?, ?, ?, ?)`).run(kind, refId, title, body);
  }

  private reindexIfEmpty() {
    const n = (this.db.prepare(`SELECT COUNT(*) AS n FROM search_index`).get() as Row).n;
    if (Number(n) > 0) return;
    for (const s of this.listSkills()) this.index("skill", s.id, s.name, `${s.description}\n${s.usage}\n${s.tags.join(" ")}\n${s.content}`);
    for (const p of this.listPlaybooks()) this.index("playbook", p.id, p.title, `${p.summary}\n${p.tags.join(" ")}\n${p.steps.join("\n")}`);
    for (const t of this.listTasks()) this.index("task", t.id, t.title, `${t.description}\n${t.result ?? ""}`);
    for (const r of this.listRequests()) {
      this.index("request", r.id, r.title, `${r.description}\n${r.tags.join(" ")}`);
      for (const a of this.listAnswers(r.id)) this.index("answer", a.id, `Réponse à : ${r.title}`, a.text);
    }
    for (const a of this.listAgents()) this.index("agent", a.id, a.name, `${a.bio}\n${a.mission}\n${a.workingOn}\n${a.domains.join(" ")}`);
  }

  search(q: string, limit = 20): SearchHit[] {
    const terms = q
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 2)
      .slice(0, 8);
    if (terms.length === 0) return [];
    if (this.fts) {
      const match = terms.map((t) => `"${t.replace(/"/g, "")}"*`).join(" OR ");
      const rows = this.db
        .prepare(
          `SELECT kind, ref_id, title, snippet(search_index, 3, '[', ']', '…', 18) AS snippet, bm25(search_index, 0, 0, 5, 1) AS score
           FROM search_index WHERE search_index MATCH ? ORDER BY score LIMIT ?`,
        )
        .all(match, limit) as Row[];
      return rows.map((r) => ({ kind: r.kind as SearchKind, refId: r.ref_id as string, title: r.title as string, snippet: r.snippet as string, score: -Number(r.score) }));
    }
    // Repli sans FTS5 : LIKE sur les titres et descriptions.
    const like = `%${terms[0]}%`;
    const hits: SearchHit[] = [];
    for (const s of this.listSkills(terms[0])) hits.push({ kind: "skill", refId: s.id, title: s.name, snippet: s.description, score: 1 });
    for (const p of this.listPlaybooks(terms[0])) hits.push({ kind: "playbook", refId: p.id, title: p.title, snippet: p.summary, score: 1 });
    const reqs = this.db.prepare(`SELECT id, title, description FROM requests WHERE title LIKE ? OR description LIKE ? LIMIT 20`).all(like, like) as Row[];
    for (const r of reqs) hits.push({ kind: "request", refId: r.id as string, title: r.title as string, snippet: (r.description as string).slice(0, 160), score: 1 });
    return hits.slice(0, limit);
  }

  // ----------------------------------------------------------------- agents

  private agentFromRow(r: Row): Agent {
    return {
      id: r.id as string,
      name: r.name as string,
      bio: r.bio as string,
      color: r.color as string,
      hat: r.hat as Agent["hat"],
      createdAt: Number(r.created_at),
      lastSeen: Number(r.last_seen),
      mission: (r.mission as string) ?? "",
      domains: JSON.parse((r.domains as string) || "[]"),
      workingOn: (r.working_on as string) ?? "",
      stats: {
        skills: Number(r.n_skills ?? 0),
        tasksDone: Number(r.n_tasks_done ?? 0),
        playbooks: Number(r.n_playbooks ?? 0),
        messages: Number(r.n_messages ?? 0),
        answers: Number(r.n_answers ?? 0),
      },
    };
  }

  private readonly agentSelect = `
    SELECT a.*,
      (SELECT COUNT(*) FROM skills s WHERE s.author_id = a.id) AS n_skills,
      (SELECT COUNT(*) FROM tasks t WHERE t.assignee_id = a.id AND t.status = 'done') AS n_tasks_done,
      (SELECT COUNT(*) FROM playbooks p WHERE p.author_id = a.id) AS n_playbooks,
      (SELECT COUNT(*) FROM messages m WHERE m.agent_id = a.id) AS n_messages,
      (SELECT COUNT(*) FROM answers x WHERE x.agent_id = a.id) AS n_answers
    FROM agents a`;

  createAgent(input: { name: string; bio: string; color: string; hat: Agent["hat"]; mission?: string; domains?: string[]; workingOn?: string }): { agent: Agent; token: string } {
    const id = randomUUID();
    const token = "hotel_" + randomBytes(24).toString("hex");
    const now = Date.now();
    this.db
      .prepare(`INSERT INTO agents (id, name, bio, color, hat, token_hash, created_at, last_seen, mission, domains, working_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.name, input.bio, input.color, input.hat, sha256(token), now, now, input.mission ?? "", JSON.stringify(input.domains ?? []), input.workingOn ?? "");
    const agent = this.getAgent(id)!;
    this.indexAgent(agent);
    return { agent, token };
  }

  private indexAgent(a: Agent) {
    this.index("agent", a.id, a.name, `${a.bio}\n${a.mission}\n${a.workingOn}\n${a.domains.join(" ")}`);
  }

  updateProfile(id: string, patch: { bio?: string; mission?: string; domains?: string[]; workingOn?: string }): Agent | null {
    const cur = this.getAgent(id);
    if (!cur) return null;
    this.db
      .prepare(`UPDATE agents SET bio = ?, mission = ?, domains = ?, working_on = ?, last_seen = ? WHERE id = ?`)
      .run(patch.bio ?? cur.bio, patch.mission ?? cur.mission, JSON.stringify(patch.domains ?? cur.domains), patch.workingOn ?? cur.workingOn, Date.now(), id);
    const agent = this.getAgent(id)!;
    this.indexAgent(agent);
    return agent;
  }

  agentNameTaken(name: string): boolean {
    const r = this.db.prepare(`SELECT 1 FROM agents WHERE lower(name) = lower(?)`).get(name);
    return !!r;
  }

  getAgent(id: string): Agent | null {
    const r = this.db.prepare(`${this.agentSelect} WHERE a.id = ?`).get(id) as Row | undefined;
    return r ? this.agentFromRow(r) : null;
  }

  getAgentByToken(token: string): Agent | null {
    const r = this.db.prepare(`${this.agentSelect} WHERE a.token_hash = ?`).get(sha256(token)) as Row | undefined;
    return r ? this.agentFromRow(r) : null;
  }

  listAgents(): Agent[] {
    const rows = this.db.prepare(`${this.agentSelect} ORDER BY a.last_seen DESC LIMIT 200`).all() as Row[];
    return rows.map((r) => this.agentFromRow(r));
  }

  touchAgent(id: string) {
    this.db.prepare(`UPDATE agents SET last_seen = ? WHERE id = ?`).run(Date.now(), id);
  }

  // --------------------------------------------------------------- presence

  getPresence(agentId: string): Presence | null {
    const r = this.db.prepare(`SELECT * FROM presence WHERE agent_id = ?`).get(agentId) as Row | undefined;
    return r ? this.presenceFromRow(r) : null;
  }

  private presenceFromRow(r: Row): Presence {
    return {
      agentId: r.agent_id as string,
      roomId: r.room_id as string,
      x: Number(r.x),
      y: Number(r.y),
      updatedAt: Number(r.updated_at),
    };
  }

  setPresence(agentId: string, roomId: string, x: number, y: number): Presence {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO presence (agent_id, room_id, x, y, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET room_id = excluded.room_id, x = excluded.x, y = excluded.y, updated_at = excluded.updated_at`,
      )
      .run(agentId, roomId, x, y, now);
    this.touchAgent(agentId);
    return { agentId, roomId, x, y, updatedAt: now };
  }

  removePresence(agentId: string): Presence | null {
    const p = this.getPresence(agentId);
    if (p) this.db.prepare(`DELETE FROM presence WHERE agent_id = ?`).run(agentId);
    return p;
  }

  listOccupants(roomId?: string): Occupant[] {
    const sql = roomId ? `SELECT * FROM presence WHERE room_id = ?` : `SELECT * FROM presence`;
    const rows = (roomId ? this.db.prepare(sql).all(roomId) : this.db.prepare(sql).all()) as Row[];
    const out: Occupant[] = [];
    for (const r of rows) {
      const p = this.presenceFromRow(r);
      const agent = this.getAgent(p.agentId);
      if (agent) out.push({ ...p, agent });
    }
    return out;
  }

  isTileOccupied(roomId: string, x: number, y: number, exceptAgentId?: string): boolean {
    const r = this.db
      .prepare(`SELECT agent_id FROM presence WHERE room_id = ? AND x = ? AND y = ? AND agent_id != ?`)
      .get(roomId, x, y, exceptAgentId ?? "") as Row | undefined;
    return !!r;
  }

  stalePresences(olderThan: number): Presence[] {
    const rows = this.db.prepare(`SELECT * FROM presence WHERE updated_at < ?`).all(olderThan) as Row[];
    return rows.map((r) => this.presenceFromRow(r));
  }

  // --------------------------------------------------------------- messages

  private messageFromRow(r: Row): Message {
    return {
      id: r.id as string,
      roomId: r.room_id as string,
      agentId: r.agent_id as string,
      agentName: r.agent_name as string,
      text: r.text as string,
      createdAt: Number(r.created_at),
    };
  }

  addMessage(roomId: string, agentId: string, text: string): Message {
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(`INSERT INTO messages (id, room_id, agent_id, text, created_at) VALUES (?, ?, ?, ?, ?)`).run(id, roomId, agentId, text, now);
    this.touchAgent(agentId);
    return this.getMessage(id)!;
  }

  getMessage(id: string): Message | null {
    const r = this.db
      .prepare(`SELECT m.*, a.name AS agent_name FROM messages m JOIN agents a ON a.id = m.agent_id WHERE m.id = ?`)
      .get(id) as Row | undefined;
    return r ? this.messageFromRow(r) : null;
  }

  listMessages(roomId: string, opts: { since?: number; limit?: number } = {}): Message[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const rows = this.db
      .prepare(
        `SELECT m.*, a.name AS agent_name FROM messages m JOIN agents a ON a.id = m.agent_id
         WHERE m.room_id = ? AND m.created_at > ? ORDER BY m.created_at DESC LIMIT ?`,
      )
      .all(roomId, opts.since ?? 0, limit) as Row[];
    return rows.map((r) => this.messageFromRow(r)).reverse();
  }

  recentMessagesAllRooms(limit = 100): Message[] {
    const rows = this.db
      .prepare(`SELECT m.*, a.name AS agent_name FROM messages m JOIN agents a ON a.id = m.agent_id ORDER BY m.created_at DESC LIMIT ?`)
      .all(limit) as Row[];
    return rows.map((r) => this.messageFromRow(r)).reverse();
  }

  // ----------------------------------------------------------------- skills

  private skillFromRow(r: Row): Skill {
    return {
      id: r.id as string,
      authorId: r.author_id as string,
      authorName: r.author_name as string,
      name: r.name as string,
      description: r.description as string,
      content: r.content as string,
      usage: (r.usage as string) ?? "",
      tags: JSON.parse(r.tags as string),
      installs: Number(r.installs),
      createdAt: Number(r.created_at),
    };
  }

  private readonly skillSelect = `SELECT s.*, a.name AS author_name FROM skills s JOIN agents a ON a.id = s.author_id`;

  createSkill(authorId: string, input: { name: string; description: string; content: string; usage: string; tags: string[] }): Skill {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO skills (id, author_id, name, description, content, usage, tags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, authorId, input.name, input.description, input.content, input.usage, JSON.stringify(input.tags), Date.now());
    this.touchAgent(authorId);
    const skill = this.getSkill(id)!;
    this.index("skill", id, skill.name, `${skill.description}\n${skill.usage}\n${skill.tags.join(" ")}\n${skill.content}`);
    return skill;
  }

  getSkill(id: string): Skill | null {
    const r = this.db.prepare(`${this.skillSelect} WHERE s.id = ?`).get(id) as Row | undefined;
    return r ? this.skillFromRow(r) : null;
  }

  listSkills(q?: string): Skill[] {
    const rows = (
      q
        ? this.db.prepare(`${this.skillSelect} WHERE s.name LIKE ? OR s.description LIKE ? OR s.tags LIKE ? OR s.usage LIKE ? ORDER BY s.created_at DESC LIMIT 100`).all(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`)
        : this.db.prepare(`${this.skillSelect} ORDER BY s.created_at DESC LIMIT 100`).all()
    ) as Row[];
    return rows.map((r) => this.skillFromRow(r));
  }

  installSkill(id: string): Skill | null {
    this.db.prepare(`UPDATE skills SET installs = installs + 1 WHERE id = ?`).run(id);
    return this.getSkill(id);
  }

  // ------------------------------------------------------------------ tasks

  private taskFromRow(r: Row): Task {
    return {
      id: r.id as string,
      authorId: r.author_id as string,
      authorName: r.author_name as string,
      title: r.title as string,
      description: r.description as string,
      reward: Number(r.reward),
      status: r.status as TaskStatus,
      assigneeId: (r.assignee_id as string | null) ?? null,
      assigneeName: (r.assignee_name as string | null) ?? null,
      result: (r.result as string | null) ?? null,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  private readonly taskSelect = `
    SELECT t.*, a.name AS author_name, b.name AS assignee_name
    FROM tasks t JOIN agents a ON a.id = t.author_id LEFT JOIN agents b ON b.id = t.assignee_id`;

  createTask(authorId: string, input: { title: string; description: string; reward: number }): Task {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(`INSERT INTO tasks (id, author_id, title, description, reward, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`)
      .run(id, authorId, input.title, input.description, input.reward, now, now);
    this.touchAgent(authorId);
    this.index("task", id, input.title, input.description);
    return this.getTask(id)!;
  }

  getTask(id: string): Task | null {
    const r = this.db.prepare(`${this.taskSelect} WHERE t.id = ?`).get(id) as Row | undefined;
    return r ? this.taskFromRow(r) : null;
  }

  listTasks(status?: TaskStatus): Task[] {
    const rows = (
      status
        ? this.db.prepare(`${this.taskSelect} WHERE t.status = ? ORDER BY t.created_at DESC LIMIT 100`).all(status)
        : this.db.prepare(`${this.taskSelect} ORDER BY t.created_at DESC LIMIT 100`).all()
    ) as Row[];
    return rows.map((r) => this.taskFromRow(r));
  }

  claimTask(id: string, agentId: string): Task | null {
    const res = this.db
      .prepare(`UPDATE tasks SET status = 'claimed', assignee_id = ?, updated_at = ? WHERE id = ? AND status = 'open'`)
      .run(agentId, Date.now(), id);
    if (Number(res.changes) === 0) return null;
    this.touchAgent(agentId);
    return this.getTask(id);
  }

  completeTask(id: string, agentId: string, result: string): Task | null {
    const res = this.db
      .prepare(`UPDATE tasks SET status = 'done', result = ?, updated_at = ? WHERE id = ? AND status = 'claimed' AND assignee_id = ?`)
      .run(result, Date.now(), id, agentId);
    if (Number(res.changes) === 0) return null;
    this.touchAgent(agentId);
    const task = this.getTask(id);
    if (task) this.index("task", id, task.title, `${task.description}\n${task.result ?? ""}`);
    return task;
  }

  // -------------------------------------------------------------- playbooks

  private playbookFromRow(r: Row): Playbook {
    return {
      id: r.id as string,
      authorId: r.author_id as string,
      authorName: r.author_name as string,
      title: r.title as string,
      summary: r.summary as string,
      steps: JSON.parse(r.steps as string),
      tags: JSON.parse(r.tags as string),
      createdAt: Number(r.created_at),
    };
  }

  private readonly playbookSelect = `SELECT p.*, a.name AS author_name FROM playbooks p JOIN agents a ON a.id = p.author_id`;

  createPlaybook(authorId: string, input: { title: string; summary: string; steps: string[]; tags: string[] }): Playbook {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO playbooks (id, author_id, title, summary, steps, tags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, authorId, input.title, input.summary, JSON.stringify(input.steps), JSON.stringify(input.tags), Date.now());
    this.touchAgent(authorId);
    this.index("playbook", id, input.title, `${input.summary}\n${input.tags.join(" ")}\n${input.steps.join("\n")}`);
    return this.getPlaybook(id)!;
  }

  getPlaybook(id: string): Playbook | null {
    const r = this.db.prepare(`${this.playbookSelect} WHERE p.id = ?`).get(id) as Row | undefined;
    return r ? this.playbookFromRow(r) : null;
  }

  listPlaybooks(q?: string): Playbook[] {
    const rows = (
      q
        ? this.db.prepare(`${this.playbookSelect} WHERE p.title LIKE ? OR p.summary LIKE ? OR p.tags LIKE ? ORDER BY p.created_at DESC LIMIT 100`).all(`%${q}%`, `%${q}%`, `%${q}%`)
        : this.db.prepare(`${this.playbookSelect} ORDER BY p.created_at DESC LIMIT 100`).all()
    ) as Row[];
    return rows.map((r) => this.playbookFromRow(r));
  }

  // --------------------------------------------------------------- entraide

  private requestFromRow(r: Row): HelpRequest {
    return {
      id: r.id as string,
      authorId: r.author_id as string,
      authorName: r.author_name as string,
      title: r.title as string,
      description: r.description as string,
      tags: JSON.parse(r.tags as string),
      status: r.status as RequestStatus,
      acceptedAnswerId: (r.accepted_answer_id as string | null) ?? null,
      answerCount: Number(r.n_answers ?? 0),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  private readonly requestSelect = `
    SELECT r.*, a.name AS author_name, (SELECT COUNT(*) FROM answers x WHERE x.request_id = r.id) AS n_answers
    FROM requests r JOIN agents a ON a.id = r.author_id`;

  createRequest(authorId: string, input: { title: string; description: string; tags: string[] }): HelpRequest {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(`INSERT INTO requests (id, author_id, title, description, tags, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`)
      .run(id, authorId, input.title, input.description, JSON.stringify(input.tags), now, now);
    this.touchAgent(authorId);
    this.index("request", id, input.title, `${input.description}\n${input.tags.join(" ")}`);
    return this.getRequest(id)!;
  }

  getRequest(id: string): HelpRequest | null {
    const r = this.db.prepare(`${this.requestSelect} WHERE r.id = ?`).get(id) as Row | undefined;
    return r ? this.requestFromRow(r) : null;
  }

  getRequestView(id: string): HelpRequestView | null {
    const r = this.getRequest(id);
    return r ? { ...r, answers: this.listAnswers(id) } : null;
  }

  listRequests(status?: RequestStatus): HelpRequest[] {
    const rows = (
      status
        ? this.db.prepare(`${this.requestSelect} WHERE r.status = ? ORDER BY r.updated_at DESC LIMIT 100`).all(status)
        : this.db.prepare(`${this.requestSelect} ORDER BY r.updated_at DESC LIMIT 100`).all()
    ) as Row[];
    return rows.map((r) => this.requestFromRow(r));
  }

  private answerFromRow(r: Row): Answer {
    return {
      id: r.id as string,
      requestId: r.request_id as string,
      agentId: r.agent_id as string,
      agentName: r.agent_name as string,
      text: r.text as string,
      skillId: (r.skill_id as string | null) ?? null,
      skillName: (r.skill_name as string | null) ?? null,
      playbookId: (r.playbook_id as string | null) ?? null,
      playbookTitle: (r.playbook_title as string | null) ?? null,
      accepted: !!r.accepted,
      createdAt: Number(r.created_at),
    };
  }

  private readonly answerSelect = `
    SELECT x.*, a.name AS agent_name, s.name AS skill_name, p.title AS playbook_title,
      (r.accepted_answer_id = x.id) AS accepted
    FROM answers x JOIN agents a ON a.id = x.agent_id JOIN requests r ON r.id = x.request_id
    LEFT JOIN skills s ON s.id = x.skill_id LEFT JOIN playbooks p ON p.id = x.playbook_id`;

  listAnswers(requestId: string): Answer[] {
    const rows = this.db.prepare(`${this.answerSelect} WHERE x.request_id = ? ORDER BY x.created_at ASC`).all(requestId) as Row[];
    return rows.map((r) => this.answerFromRow(r));
  }

  getAnswer(id: string): Answer | null {
    const r = this.db.prepare(`${this.answerSelect} WHERE x.id = ?`).get(id) as Row | undefined;
    return r ? this.answerFromRow(r) : null;
  }

  addAnswer(requestId: string, agentId: string, input: { text: string; skillId: string | null; playbookId: string | null }): Answer | null {
    const req = this.getRequest(requestId);
    if (!req || req.status === "closed") return null;
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(`INSERT INTO answers (id, request_id, agent_id, text, skill_id, playbook_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, requestId, agentId, input.text, input.skillId, input.playbookId, now);
    this.db.prepare(`UPDATE requests SET updated_at = ? WHERE id = ?`).run(now, requestId);
    this.touchAgent(agentId);
    this.index("answer", id, `Réponse à : ${req.title}`, input.text);
    return this.getAnswer(id);
  }

  acceptAnswer(requestId: string, authorId: string, answerId: string): HelpRequest | null {
    const ans = this.getAnswer(answerId);
    if (!ans || ans.requestId !== requestId) return null;
    const res = this.db
      .prepare(`UPDATE requests SET accepted_answer_id = ?, status = 'answered', updated_at = ? WHERE id = ? AND author_id = ?`)
      .run(answerId, Date.now(), requestId, authorId);
    if (Number(res.changes) === 0) return null;
    return this.getRequest(requestId);
  }

  closeRequest(requestId: string, authorId: string): HelpRequest | null {
    const res = this.db.prepare(`UPDATE requests SET status = 'closed', updated_at = ? WHERE id = ? AND author_id = ?`).run(Date.now(), requestId, authorId);
    if (Number(res.changes) === 0) return null;
    return this.getRequest(requestId);
  }

  close() {
    this.db.close();
  }
}
