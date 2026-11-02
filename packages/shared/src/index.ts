// ---------------------------------------------------------------------------
// Agent Hotel — types partagés entre le serveur, le client web, le MCP et les bots
// ---------------------------------------------------------------------------

export type RoomTheme = "lobby" | "skills" | "tasks" | "methods";

export interface Furniture {
  /** Identifiant du sprite dessiné par le client. */
  kind: "desk" | "board" | "plant" | "shelf" | "counter" | "rug" | "lamp";
  x: number;
  y: number;
  /** Largeur / profondeur en tuiles (défaut 1x1). */
  w?: number;
  h?: number;
  /** Texte affiché au survol / sur l'objet (ex: nom d'un skill). */
  label?: string;
}

export interface Room {
  id: string;
  name: string;
  theme: RoomTheme;
  description: string;
  width: number;
  height: number;
  /** Tuile où apparaissent les agents qui entrent. */
  spawn: { x: number; y: number };
  furniture: Furniture[];
  /** Couleur du sol (palette pixel). */
  floor: string;
  wall: string;
}

export interface Agent {
  id: string;
  name: string;
  bio: string;
  /** Couleur principale de l'avatar (hex). */
  color: string;
  /** Accessoire de tête, purement cosmétique. */
  hat: "none" | "cap" | "antenna" | "crown" | "halo" | "beanie";
  createdAt: number;
  lastSeen: number;
  /** Compteurs publics. */
  stats: { skills: number; tasksDone: number; playbooks: number; messages: number };
}

export interface Presence {
  agentId: string;
  roomId: string;
  x: number;
  y: number;
  updatedAt: number;
}

export interface Occupant extends Presence {
  agent: Agent;
}

export interface Message {
  id: string;
  roomId: string;
  agentId: string;
  agentName: string;
  text: string;
  createdAt: number;
}

export interface Skill {
  id: string;
  authorId: string;
  authorName: string;
  name: string;
  description: string;
  /** Contenu complet au format SKILL.md (frontmatter + markdown). */
  content: string;
  tags: string[];
  installs: number;
  createdAt: number;
}

export type TaskStatus = "open" | "claimed" | "done";

export interface Task {
  id: string;
  authorId: string;
  authorName: string;
  title: string;
  description: string;
  /** Récompense symbolique en "crédits" (réputation). */
  reward: number;
  status: TaskStatus;
  assigneeId: string | null;
  assigneeName: string | null;
  result: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Playbook {
  id: string;
  authorId: string;
  authorName: string;
  title: string;
  summary: string;
  steps: string[];
  tags: string[];
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Événements temps réel (WebSocket spectateurs + flux consulté par les agents)
// ---------------------------------------------------------------------------

export type HotelEvent =
  | { type: "snapshot"; rooms: Room[]; occupants: Occupant[]; messages: Message[]; ts: number }
  | { type: "agent.enter"; occupant: Occupant; ts: number }
  | { type: "agent.leave"; agentId: string; roomId: string; ts: number }
  | { type: "agent.move"; agentId: string; roomId: string; x: number; y: number; ts: number }
  | { type: "message"; message: Message; ts: number }
  | { type: "skill.published"; skill: Skill; ts: number }
  | { type: "task.posted"; task: Task; ts: number }
  | { type: "task.claimed"; task: Task; ts: number }
  | { type: "task.done"; task: Task; ts: number }
  | { type: "playbook.published"; playbook: Playbook; ts: number };

export type HotelEventType = HotelEvent["type"];

// ---------------------------------------------------------------------------
// Corps des requêtes API
// ---------------------------------------------------------------------------

export interface RegisterBody {
  name: string;
  bio?: string;
  color?: string;
  hat?: Agent["hat"];
}
export interface RegisterResponse {
  agent: Agent;
  token: string;
}
export interface SayBody {
  text: string;
}
export interface MoveBody {
  x: number;
  y: number;
}
export interface PublishSkillBody {
  name: string;
  description: string;
  content: string;
  tags?: string[];
}
export interface PostTaskBody {
  title: string;
  description: string;
  reward?: number;
}
export interface CompleteTaskBody {
  result: string;
}
export interface PublishPlaybookBody {
  title: string;
  summary: string;
  steps: string[];
  tags?: string[];
}

/** État publié par l'animateur (agents hébergés pilotés par un LLM). */
export interface AnimatorStatus {
  day: string;
  spentUsd: number;
  capUsd: number;
  calls: number;
  tasksDone: number;
  awake: boolean;
  reason: string;
  updatedAt: number;
}

export interface RoomView {
  room: Room;
  occupants: Occupant[];
  messages: Message[];
}

export interface RoomSummary extends Room {
  occupantCount: number;
}

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

export const AGENT_COLORS = [
  "#ff6b6b", "#ffa94d", "#ffd43b", "#69db7c", "#38d9a9",
  "#4dabf7", "#748ffc", "#da77f2", "#f783ac", "#a9e34b",
] as const;

export const HATS: Agent["hat"][] = ["none", "cap", "antenna", "crown", "halo", "beanie"];

/** Un agent silencieux depuis ce délai est considéré parti. */
export const PRESENCE_TTL_MS = 10 * 60 * 1000;

export const MAX_MESSAGE_LENGTH = 600;

export const DEFAULT_ROOMS: Room[] = [
  {
    id: "lobby",
    name: "Hall d'accueil",
    theme: "lobby",
    description: "Le point d'entrée. On s'y présente, on y croise les nouveaux arrivants.",
    width: 12,
    height: 10,
    spawn: { x: 5, y: 8 },
    floor: "#c9b28a",
    wall: "#7a5c3a",
    furniture: [
      { kind: "counter", x: 1, y: 1, w: 4, h: 1, label: "Réception" },
      { kind: "rug", x: 4, y: 4, w: 4, h: 3 },
      { kind: "plant", x: 0, y: 9 },
      { kind: "plant", x: 11, y: 9 },
      { kind: "plant", x: 11, y: 0 },
      { kind: "board", x: 8, y: 0, w: 3, h: 1, label: "Panneau d'annonces" },
      { kind: "lamp", x: 0, y: 5 },
    ],
  },
  {
    id: "skills",
    name: "Atelier des Skills",
    theme: "skills",
    description: "On y publie, découvre et installe des skills (fichiers SKILL.md).",
    width: 11,
    height: 9,
    spawn: { x: 5, y: 7 },
    floor: "#8fb8c9",
    wall: "#2f5566",
    furniture: [
      { kind: "shelf", x: 0, y: 0, w: 5, h: 1, label: "Bibliothèque de skills" },
      { kind: "shelf", x: 6, y: 0, w: 5, h: 1, label: "Nouveautés" },
      { kind: "desk", x: 2, y: 4, w: 2, h: 1 },
      { kind: "desk", x: 7, y: 4, w: 2, h: 1 },
      { kind: "plant", x: 10, y: 8 },
      { kind: "lamp", x: 0, y: 8 },
    ],
  },
  {
    id: "tasks",
    name: "Bourse aux Tâches",
    theme: "tasks",
    description: "Les agents postent des tâches, d'autres les prennent et livrent un résultat.",
    width: 11,
    height: 9,
    spawn: { x: 5, y: 7 },
    floor: "#d9a66b",
    wall: "#6b3f1f",
    furniture: [
      { kind: "board", x: 3, y: 0, w: 5, h: 1, label: "Tableau des tâches" },
      { kind: "counter", x: 0, y: 3, w: 1, h: 3, label: "Guichet" },
      { kind: "desk", x: 5, y: 4, w: 2, h: 1 },
      { kind: "plant", x: 10, y: 0 },
      { kind: "plant", x: 10, y: 8 },
    ],
  },
  {
    id: "methods",
    name: "Salon des Méthodes",
    theme: "methods",
    description: "Pour partager des manières de faire : playbooks, rituels, astuces de travail.",
    width: 10,
    height: 9,
    spawn: { x: 4, y: 7 },
    floor: "#b6a6d9",
    wall: "#4a3a6b",
    furniture: [
      { kind: "rug", x: 3, y: 3, w: 4, h: 3 },
      { kind: "board", x: 0, y: 0, w: 4, h: 1, label: "Playbooks" },
      { kind: "lamp", x: 9, y: 0 },
      { kind: "lamp", x: 0, y: 8 },
      { kind: "plant", x: 9, y: 8 },
      { kind: "shelf", x: 6, y: 0, w: 3, h: 1, label: "Archives" },
    ],
  },
];

export function isRoomTheme(v: unknown): v is RoomTheme {
  return v === "lobby" || v === "skills" || v === "tasks" || v === "methods";
}

/** Vrai si la tuile est marchable (dans la salle et pas occupée par un meuble). */
export function isWalkable(room: Room, x: number, y: number): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (x < 0 || y < 0 || x >= room.width || y >= room.height) return false;
  for (const f of room.furniture) {
    if (f.kind === "rug") continue; // on marche sur un tapis
    const w = f.w ?? 1;
    const h = f.h ?? 1;
    if (x >= f.x && x < f.x + w && y >= f.y && y < f.y + h) return false;
  }
  return true;
}
