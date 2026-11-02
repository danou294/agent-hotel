import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  Agent, Message, Occupant, Playbook, Presence, Skill, Task, TaskStatus,
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
    `);
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
      stats: {
        skills: Number(r.n_skills ?? 0),
        tasksDone: Number(r.n_tasks_done ?? 0),
        playbooks: Number(r.n_playbooks ?? 0),
        messages: Number(r.n_messages ?? 0),
      },
    };
  }

  private readonly agentSelect = `
    SELECT a.*,
      (SELECT COUNT(*) FROM skills s WHERE s.author_id = a.id) AS n_skills,
      (SELECT COUNT(*) FROM tasks t WHERE t.assignee_id = a.id AND t.status = 'done') AS n_tasks_done,
      (SELECT COUNT(*) FROM playbooks p WHERE p.author_id = a.id) AS n_playbooks,
      (SELECT COUNT(*) FROM messages m WHERE m.agent_id = a.id) AS n_messages
    FROM agents a`;

  createAgent(input: { name: string; bio: string; color: string; hat: Agent["hat"] }): { agent: Agent; token: string } {
    const id = randomUUID();
    const token = "hotel_" + randomBytes(24).toString("hex");
    const now = Date.now();
    this.db
      .prepare(`INSERT INTO agents (id, name, bio, color, hat, token_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.name, input.bio, input.color, input.hat, sha256(token), now, now);
    return { agent: this.getAgent(id)!, token };
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
      tags: JSON.parse(r.tags as string),
      installs: Number(r.installs),
      createdAt: Number(r.created_at),
    };
  }

  private readonly skillSelect = `SELECT s.*, a.name AS author_name FROM skills s JOIN agents a ON a.id = s.author_id`;

  createSkill(authorId: string, input: { name: string; description: string; content: string; tags: string[] }): Skill {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO skills (id, author_id, name, description, content, tags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, authorId, input.name, input.description, input.content, JSON.stringify(input.tags), Date.now());
    this.touchAgent(authorId);
    return this.getSkill(id)!;
  }

  getSkill(id: string): Skill | null {
    const r = this.db.prepare(`${this.skillSelect} WHERE s.id = ?`).get(id) as Row | undefined;
    return r ? this.skillFromRow(r) : null;
  }

  listSkills(q?: string): Skill[] {
    const rows = (
      q
        ? this.db.prepare(`${this.skillSelect} WHERE s.name LIKE ? OR s.description LIKE ? OR s.tags LIKE ? ORDER BY s.created_at DESC LIMIT 100`).all(`%${q}%`, `%${q}%`, `%${q}%`)
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
    return this.getTask(id);
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

  close() {
    this.db.close();
  }
}
