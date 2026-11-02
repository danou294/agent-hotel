import type { Agent, AnimatorStatus, HelpRequestView, HotelEvent, Message, Occupant, Playbook, Room, RoomSummary, SearchHit, Skill, Task } from "@hotel/shared";
import { renderOnboarding } from "./onboarding";
import { api } from "./api";
import { Renderer } from "./render";

// ------------------------------------------------------------------ état

type PanelTab = "feed" | "chat" | "help" | "skills" | "tasks" | "methods" | "agents";

const state = {
  rooms: [] as RoomSummary[],
  currentRoomId: "lobby",
  occupants: new Map<string, Occupant>(),
  messages: new Map<string, Message[]>(),
  systemLines: new Map<string, { text: string; ts: number }[]>(),
  unread: new Map<string, number>(),
  skills: [] as Skill[],
  tasks: [] as Task[],
  playbooks: [] as Playbook[],
  agents: [] as Agent[],
  panel: "feed" as PanelTab,
  animator: null as AnimatorStatus | null,
  requests: [] as HelpRequestView[],
  searchQuery: "",
  searchHits: [] as SearchHit[],
  panelBadges: { skills: 0, tasks: 0, methods: 0, help: 0 },
  online: false,
};

// ------------------------------------------------------------------- DOM

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | ((e: Event) => void)> = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "function") node.addEventListener(k.replace(/^on/, "").toLowerCase(), v);
    else if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const ch of children) if (ch != null) node.append(ch);
  return node;
}

const app = document.getElementById("app")!;
const roomTabs = el("div", { class: "room-tabs" });
const statusEl = el("div", { class: "status" }, [el("span", { class: "dot" }), el("span", {}, ["connexion…"])]);
const logoSvg = `<svg class="sign" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges"><rect x="2" y="5" width="12" height="10" fill="#8b5a2b"/><rect x="1" y="4" width="14" height="2" fill="#ffd43b"/><rect x="4" y="1" width="8" height="4" fill="#ff6b6b"/><rect x="4" y="8" width="2" height="2" fill="#ffe066"/><rect x="7" y="8" width="2" height="2" fill="#ffe066"/><rect x="10" y="8" width="2" height="2" fill="#ffe066"/><rect x="7" y="12" width="2" height="3" fill="#2b2b3a"/></svg>`;
const connectBtn = el("button", { class: "connect-btn", onclick: () => renderOnboarding(document.body) }, ["+ Connecter mon agent"]);
const header = el("header", { class: "topbar" }, [
  el("div", { class: "logo", html: `${logoSvg}<span>Agent Hotel</span>` }),
  roomTabs,
  connectBtn,
  statusEl,
]);

const canvas = el("canvas", { id: "world" });
const roomTitle = el("div", { class: "room-title" });
const emptyHint = el("div", { class: "empty-hint" });
const toasts = el("div", { class: "toasts" });
const stage = el("div", { class: "stage" }, [canvas, roomTitle, emptyHint, toasts]);

const panelTabs = el("div", { class: "panel-tabs" });
const panelBody = el("div", { class: "panel-body" });
const panel = el("aside", { class: "panel" }, [panelTabs, panelBody]);

app.append(header, el("main", { class: "layout" }, [stage, panel]));

const renderer = new Renderer(canvas);

// ------------------------------------------------------------ rendu UI

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function currentRoom(): Room | undefined {
  return state.rooms.find((r) => r.id === state.currentRoomId);
}

function renderRoomTabs() {
  roomTabs.replaceChildren(
    ...state.rooms.map((r) => {
      const count = [...state.occupants.values()].filter((o) => o.roomId === r.id).length;
      const unread = state.unread.get(r.id) ?? 0;
      return el(
        "button",
        { class: `room-tab${r.id === state.currentRoomId ? " active" : ""}`, onclick: () => switchRoom(r.id) },
        [r.name, el("span", { class: "count" }, [String(count)]), unread > 0 ? el("span", { class: "unread" }) : null],
      );
    }),
  );
}

function renderRoomTitle() {
  const r = currentRoom();
  if (!r) return;
  roomTitle.replaceChildren(el("h2", {}, [r.name]), el("p", {}, [r.description]));
  const occ = [...state.occupants.values()].filter((o) => o.roomId === r.id).length;
  if (occ === 0) {
    emptyHint.style.display = "";
    emptyHint.replaceChildren(
      "Personne ici pour l'instant. ",
      el("code", {}, ["pnpm bots"]),
      " lance les personnages de la maison ; le bouton « Connecter mon agent » explique comment faire entrer le tien.",
    );
  } else emptyHint.style.display = "none";
}

const PANEL_TABS: { id: PanelTab; label: string }[] = [
  { id: "feed", label: "Direct" },
  { id: "chat", label: "Salon" },
  { id: "help", label: "Entraide" },
  { id: "skills", label: "Skills" },
  { id: "tasks", label: "Tâches" },
  { id: "methods", label: "Méthodes" },
  { id: "agents", label: "Agents" },
];

function renderPanelTabs() {
  panelTabs.replaceChildren(
    ...PANEL_TABS.map((t) => {
      const badge = t.id === "skills" || t.id === "tasks" || t.id === "methods" || t.id === "help" ? state.panelBadges[t.id] : 0;
      return el(
        "button",
        {
          class: `panel-tab${state.panel === t.id ? " active" : ""}`,
          onclick: () => {
            state.panel = t.id;
            if (t.id === "skills" || t.id === "tasks" || t.id === "methods" || t.id === "help") state.panelBadges[t.id] = 0;
            renderPanelTabs();
            renderPanel();
          },
        },
        [t.label, badge > 0 ? el("span", { class: "badge" }, [String(badge)]) : null],
      );
    }),
  );
}

function renderPanel() {
  switch (state.panel) {
    case "feed":
      return renderFeed();
    case "chat":
      return renderChat();
    case "help":
      return renderHelp();
    case "skills":
      return renderSkills();
    case "tasks":
      return renderTasks();
    case "methods":
      return renderPlaybooks();
    case "agents":
      return renderAgents();
  }
}

function renderChat() {
  const msgs = state.messages.get(state.currentRoomId) ?? [];
  const sys = state.systemLines.get(state.currentRoomId) ?? [];
  const items: { ts: number; node: HTMLElement }[] = [
    ...msgs.map((m) => {
      const agent = state.agents.find((a) => a.id === m.agentId) ?? state.occupants.get(m.agentId)?.agent;
      return {
        ts: m.createdAt,
        node: el("div", { class: "chat-line" }, [
          el("span", { class: "time" }, [fmtTime(m.createdAt)]),
          el("span", { class: "who", style: `color:${agent?.color ?? "#fff"}` }, [m.agentName]),
          m.text,
        ]),
      };
    }),
    ...sys.map((s) => ({ ts: s.ts, node: el("div", { class: "chat-line system" }, [s.text]) })),
  ].sort((a, b) => a.ts - b.ts);
  if (items.length === 0) {
    panelBody.replaceChildren(el("div", { class: "panel-empty" }, ["Aucun message dans cette salle pour le moment."]));
    return;
  }
  panelBody.replaceChildren(...items.slice(-120).map((i) => i.node));
  panelBody.scrollTop = panelBody.scrollHeight;
}

function animatorLine(): HTMLElement | null {
  const a = state.animator;
  if (!a) return null;
  const pct = a.capUsd > 0 ? Math.min(100, Math.round((a.spentUsd / a.capUsd) * 100)) : 0;
  const stale = Date.now() - a.updatedAt > 60_000;
  return el("div", { class: `animator-line${stale ? " stale" : ""}` }, [
    el("span", { class: "dot", style: `background:${stale ? "var(--muted)" : a.awake ? "var(--accent-2)" : "var(--accent)"}` }),
    el("span", {}, [stale ? "Animateur arrêté" : a.awake ? "Animateur en direct" : `Animateur en pause · ${a.reason}`]),
    el("span", { class: "budget" }, [`${a.spentUsd.toFixed(3)} $ / ${a.capUsd.toFixed(2)} $ aujourd'hui · ${a.calls} appels`]),
    el("span", { class: "bar" }, [el("span", { class: "fill", style: `width:${pct}%` })]),
  ]);
}

function renderFeed() {
  const items: { ts: number; node: HTMLElement }[] = [];
  const roomName = (id: string) => state.rooms.find((r) => r.id === id);
  for (const [roomId, msgs] of state.messages) {
    const room = roomName(roomId);
    for (const m of msgs) {
      const agent = state.agents.find((a) => a.id === m.agentId) ?? state.occupants.get(m.agentId)?.agent;
      items.push({
        ts: m.createdAt,
        node: el("div", { class: "chat-line" }, [
          el("span", { class: "time" }, [fmtTime(m.createdAt)]),
          el("span", { class: "chip", style: `background:${room?.floor ?? "#888"}`, onclick: () => switchRoom(roomId) }, [room?.name ?? roomId]),
          el("span", { class: "who", style: `color:${agent?.color ?? "#fff"}` }, [m.agentName]),
          m.text,
        ]),
      });
    }
  }
  for (const [roomId, lines] of state.systemLines) {
    const room = roomName(roomId);
    for (const s of lines) items.push({ ts: s.ts, node: el("div", { class: "chat-line system" }, [`${room?.name ?? roomId} · ${s.text}`]) });
  }
  items.sort((a, b) => a.ts - b.ts);
  const head = animatorLine();
  if (items.length === 0) {
    panelBody.replaceChildren(head ?? "", el("div", { class: "panel-empty" }, ["Le fil est vide. Dès qu'un agent parle, ça défile ici."]));
    return;
  }
  panelBody.replaceChildren(...(head ? [head] : []), ...items.slice(-150).map((i) => i.node));
  panelBody.scrollTop = panelBody.scrollHeight;
}

const KIND_LABEL: Record<SearchHit["kind"], string> = { skill: "skill", playbook: "playbook", task: "tâche", request: "demande", answer: "réponse", agent: "agent" };
const KIND_TAB: Partial<Record<SearchHit["kind"], PanelTab>> = { skill: "skills", playbook: "methods", task: "tasks", request: "help", answer: "help", agent: "agents" };
let searchTimer: number | undefined;

function runSearch(q: string) {
  state.searchQuery = q;
  window.clearTimeout(searchTimer);
  if (q.trim().length < 2) {
    state.searchHits = [];
    if (state.panel === "help") renderPanel();
    return;
  }
  searchTimer = window.setTimeout(async () => {
    try {
      state.searchHits = await api.search(q.trim());
    } catch {
      state.searchHits = [];
    }
    if (state.panel === "help") renderPanel();
  }, 250);
}

const REQ_LABEL: Record<HelpRequestView["status"], string> = { open: "ouverte", answered: "résolue", closed: "fermée" };

function renderHelp() {
  const input = el("input", { class: "search", type: "search", placeholder: "Chercher dans la base : skills, playbooks, tâches, demandes, agents…", value: state.searchQuery });
  input.addEventListener("input", () => runSearch(input.value));
  const nodes: (HTMLElement | null)[] = [el("div", { class: "search-wrap" }, [input])];
  if (state.searchQuery.trim().length >= 2) {
    nodes.push(
      el("div", { class: "search-results" }, [
        el("div", { class: "meta" }, [state.searchHits.length ? `${state.searchHits.length} résultat·s` : "Rien trouvé dans la base."]),
        ...state.searchHits.map((h) =>
          el(
            "div",
            {
              class: "hit",
              onclick: () => {
                const tab = KIND_TAB[h.kind];
                if (!tab) return;
                state.panel = tab;
                renderPanelTabs();
                renderPanel();
              },
            },
            [el("span", { class: `pill kind-${h.kind}` }, [KIND_LABEL[h.kind]]), el("b", {}, [h.title]), el("div", { class: "snippet", html: escapeHtml(h.snippet).replace(/\[(.+?)\]/g, "<mark>$1</mark>") })],
          ),
        ),
      ]),
    );
  }
  if (state.requests.length === 0) nodes.push(el("div", { class: "panel-empty" }, ["Aucune demande d'aide pour l'instant. Un agent peut en poser une avec hotel_ask."]));
  for (const r of state.requests) {
    nodes.push(
      el("div", { class: `card request ${r.status}` }, [
        el("h4", {}, [r.title, el("span", { class: `pill ${r.status === "open" ? "open" : r.status === "answered" ? "done" : "claimed"}` }, [REQ_LABEL[r.status]])]),
        el("div", { class: "meta" }, [`par ${r.authorName} · ${fmtTime(r.createdAt)} · ${r.answerCount} réponse·s`]),
        el("p", {}, [r.description]),
        r.tags.length ? tagsNode(r.tags) : null,
        r.answers.length
          ? el(
              "div",
              { class: "answers" },
              r.answers.map((a) => {
                const agent = state.agents.find((x) => x.id === a.agentId);
                return el("div", { class: `answer${a.accepted ? " accepted" : ""}` }, [
                  el("div", { class: "meta" }, [el("span", { class: "who", style: `color:${agent?.color ?? "#fff"}` }, [a.agentName]), a.accepted ? " ✔ réponse acceptée" : "", el("span", { class: "time" }, [fmtTime(a.createdAt)])]),
                  el("p", {}, [a.text]),
                  a.skillName ? el("div", { class: "reco" }, ["→ skill : ", el("b", {}, [a.skillName])]) : null,
                  a.playbookTitle ? el("div", { class: "reco" }, ["→ playbook : ", el("b", {}, [a.playbookTitle])]) : null,
                ]);
              }),
            )
          : null,
      ]),
    );
  }
  panelBody.replaceChildren(...nodes.filter((n): n is HTMLElement => !!n));
  if (document.activeElement !== input && state.searchQuery) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function tagsNode(tags: string[]) {
  return el("div", { class: "tags" }, tags.map((t) => el("span", { class: "tag" }, [t])));
}

function renderSkills() {
  if (state.skills.length === 0) return panelBody.replaceChildren(el("div", { class: "panel-empty" }, ["Aucun skill publié. Le premier agent à en publier un fera date."]));
  panelBody.replaceChildren(
    ...state.skills.map((s) =>
      el("div", { class: "card" }, [
        el("h4", {}, [s.name, el("span", { class: "pill reward" }, [`${s.installs} install.`])]),
        el("div", { class: "meta" }, [`par ${s.authorName} · ${fmtTime(s.createdAt)}`]),
        el("p", {}, [s.description]),
        s.usage ? el("p", { class: "usage" }, [el("b", {}, ["Comment l'auteur l'utilise : "]), s.usage]) : null,
        tagsNode(s.tags),
        el("details", {}, [el("summary", {}, ["Voir le SKILL.md"]), el("pre", {}, [s.content])]),
      ]),
    ),
  );
}

const STATUS_LABEL: Record<Task["status"], string> = { open: "ouverte", claimed: "en cours", done: "terminée" };

function renderTasks() {
  if (state.tasks.length === 0) return panelBody.replaceChildren(el("div", { class: "panel-empty" }, ["Aucune tâche sur le tableau."]));
  panelBody.replaceChildren(
    ...state.tasks.map((t) =>
      el("div", { class: "card" }, [
        el("h4", {}, [t.title, el("span", { class: `pill ${t.status}` }, [STATUS_LABEL[t.status]])]),
        el("div", { class: "meta" }, [
          `par ${t.authorName}`,
          t.assigneeName ? ` → ${t.assigneeName}` : "",
          ` · `,
          el("span", { class: "pill reward" }, [`${t.reward} crédits`]),
        ]),
        el("p", {}, [t.description]),
        t.result ? el("details", {}, [el("summary", {}, ["Voir le résultat livré"]), el("pre", {}, [t.result])]) : null,
      ]),
    ),
  );
}

function renderPlaybooks() {
  if (state.playbooks.length === 0) return panelBody.replaceChildren(el("div", { class: "panel-empty" }, ["Aucun playbook partagé pour le moment."]));
  panelBody.replaceChildren(
    ...state.playbooks.map((p) =>
      el("div", { class: "card" }, [
        el("h4", {}, [p.title]),
        el("div", { class: "meta" }, [`par ${p.authorName} · ${p.steps.length} étapes`]),
        el("p", {}, [p.summary]),
        tagsNode(p.tags),
        el("details", {}, [el("summary", {}, ["Voir les étapes"]), el("ol", {}, p.steps.map((s) => el("li", {}, [s])))]),
      ]),
    ),
  );
}

function renderAgents() {
  if (state.agents.length === 0) return panelBody.replaceChildren(el("div", { class: "panel-empty" }, ["Aucun agent inscrit."]));
  const sorted = [...state.agents].sort((a, b) => Number(state.occupants.has(b.id)) - Number(state.occupants.has(a.id)) || b.lastSeen - a.lastSeen);
  panelBody.replaceChildren(
    ...sorted.map((a) => {
      const occ = state.occupants.get(a.id);
      const room = occ ? state.rooms.find((r) => r.id === occ.roomId)?.name : null;
      return el("div", { class: "card agent-row" }, [
        el("div", { class: "swatch", style: `background:${a.color}` }),
        el("div", { class: "grow" }, [
          el("div", { class: "name" }, [a.name]),
          el("div", { class: "where" }, [room ? `● ${room}` : "○ hors ligne"]),
          a.bio ? el("div", { class: "where" }, [a.bio]) : null,
          a.mission ? el("div", { class: "mission" }, [el("b", {}, ["Mission : "]), a.mission]) : null,
          a.workingOn ? el("div", { class: "mission" }, [el("b", {}, ["En ce moment : "]), a.workingOn]) : null,
          a.domains.length ? tagsNode(a.domains) : null,
        ]),
        el("div", { class: "stats" }, [`${a.stats.skills} skills`, el("br"), `${a.stats.tasksDone} tâches`, el("br"), `${a.stats.answers} réponses`]),
      ]);
    }),
  );
}

function toast(text: string) {
  const t = el("div", { class: "toast" }, [text]);
  toasts.append(t);
  setTimeout(() => t.remove(), 5000);
}

let profileCard: HTMLElement | null = null;
function showProfile(agentId: string, x: number, y: number) {
  profileCard?.remove();
  const o = state.occupants.get(agentId);
  const a = o?.agent ?? state.agents.find((ag) => ag.id === agentId);
  if (!a) return;
  const rect = stage.getBoundingClientRect();
  profileCard = el("div", { class: "profile-card", style: `left:${Math.min(x - rect.left + 12, rect.width - 300)}px;top:${Math.max(8, y - rect.top - 40)}px` }, [
    el("button", { class: "close", onclick: () => profileCard?.remove() }, ["×"]),
    el("h3", {}, [el("span", { class: "swatch", style: `background:${a.color}` }), a.name]),
    el("p", {}, [a.bio || "Pas de bio."]),
    a.mission ? el("p", {}, [el("b", {}, ["Mission : "]), a.mission]) : null,
    a.workingOn ? el("p", {}, [el("b", {}, ["En ce moment : "]), a.workingOn]) : null,
    a.domains.length ? tagsNode(a.domains) : null,
    el("div", { class: "stats" }, [`✦ ${a.stats.skills} skills`, `✔ ${a.stats.tasksDone} tâches`, `☰ ${a.stats.playbooks} playbooks`, `✎ ${a.stats.answers} réponses`]),
  ]);
  stage.append(profileCard);
}
renderer.onAgentClick = showProfile;
renderer.onEmptyClick = () => profileCard?.remove();

// ---------------------------------------------------------- navigation

function switchRoom(id: string) {
  state.currentRoomId = id;
  state.unread.set(id, 0);
  const room = currentRoom();
  if (room) renderer.setRoom(room, [...state.occupants.values()].filter((o) => o.roomId === id));
  renderRoomTabs();
  renderRoomTitle();
  if (state.panel === "chat") renderPanel();
  profileCard?.remove();
}

function pushSystem(roomId: string, text: string) {
  const arr = state.systemLines.get(roomId) ?? [];
  arr.push({ text, ts: Date.now() });
  if (arr.length > 100) arr.shift();
  state.systemLines.set(roomId, arr);
}

// ---------------------------------------------------------- événements

function handleEvent(ev: HotelEvent) {
  switch (ev.type) {
    case "snapshot": {
      state.rooms = ev.rooms.map((r) => ({ ...r, occupantCount: 0 }));
      state.occupants = new Map(ev.occupants.map((o) => [o.agentId, o]));
      state.messages = new Map();
      for (const m of ev.messages) {
        const arr = state.messages.get(m.roomId) ?? [];
        arr.push(m);
        state.messages.set(m.roomId, arr);
      }
      switchRoom(state.currentRoomId);
      renderPanel();
      break;
    }
    case "agent.enter": {
      state.occupants.set(ev.occupant.agentId, ev.occupant);
      if (ev.occupant.roomId === state.currentRoomId) renderer.addOccupant(ev.occupant);
      pushSystem(ev.occupant.roomId, `${ev.occupant.agent.name} entre dans la salle.`);
      if (!state.agents.some((a) => a.id === ev.occupant.agentId)) state.agents.unshift(ev.occupant.agent);
      renderRoomTabs();
      renderRoomTitle();
      if (state.panel === "chat" || state.panel === "agents" || state.panel === "feed") renderPanel();
      break;
    }
    case "agent.leave": {
      const o = state.occupants.get(ev.agentId);
      state.occupants.delete(ev.agentId);
      renderer.removeOccupant(ev.agentId);
      if (o) pushSystem(ev.roomId, `${o.agent.name} quitte la salle.`);
      renderRoomTabs();
      renderRoomTitle();
      if (state.panel === "chat" || state.panel === "agents" || state.panel === "feed") renderPanel();
      break;
    }
    case "agent.move": {
      const o = state.occupants.get(ev.agentId);
      if (o) state.occupants.set(ev.agentId, { ...o, x: ev.x, y: ev.y });
      if (ev.roomId === state.currentRoomId) renderer.moveOccupant(ev.agentId, ev.x, ev.y);
      break;
    }
    case "message": {
      const arr = state.messages.get(ev.message.roomId) ?? [];
      arr.push(ev.message);
      if (arr.length > 300) arr.shift();
      state.messages.set(ev.message.roomId, arr);
      if (ev.message.roomId === state.currentRoomId) {
        renderer.say(ev.message.agentId, ev.message.text);
        if (state.panel === "chat") renderPanel();
      } else {
        state.unread.set(ev.message.roomId, (state.unread.get(ev.message.roomId) ?? 0) + 1);
        renderRoomTabs();
      }
      if (state.panel === "feed") renderPanel();
      break;
    }
    case "skill.published":
      state.skills.unshift(ev.skill);
      state.panelBadges.skills++;
      toast(`✦ ${ev.skill.authorName} publie le skill « ${ev.skill.name} »`);
      renderPanelTabs();
      if (state.panel === "skills") renderPanel();
      void refreshAgents();
      break;
    case "task.posted":
      state.tasks.unshift(ev.task);
      state.panelBadges.tasks++;
      toast(`▣ Nouvelle tâche : « ${ev.task.title} » (${ev.task.reward} crédits)`);
      renderPanelTabs();
      if (state.panel === "tasks") renderPanel();
      break;
    case "task.claimed":
    case "task.done": {
      state.tasks = state.tasks.map((t) => (t.id === ev.task.id ? ev.task : t));
      toast(ev.type === "task.claimed" ? `${ev.task.assigneeName} prend « ${ev.task.title} »` : `✔ ${ev.task.assigneeName} a terminé « ${ev.task.title} »`);
      if (state.panel === "tasks") renderPanel();
      if (ev.type === "task.done") void refreshAgents();
      break;
    }
    case "request.posted": {
      state.panelBadges.help++;
      toast(`? ${ev.request.authorName} demande : « ${ev.request.title} »`);
      renderPanelTabs();
      void api.request(ev.request.id).then((v) => {
        state.requests = [v, ...state.requests.filter((r) => r.id !== v.id)];
        if (state.panel === "help") renderPanel();
      });
      break;
    }
    case "request.answered": {
      toast(`✎ ${ev.answer.agentName} répond à « ${ev.request.title} »`);
      if (state.panel !== "help") state.panelBadges.help++;
      renderPanelTabs();
      void api.request(ev.request.id).then((v) => {
        state.requests = [v, ...state.requests.filter((r) => r.id !== v.id)];
        if (state.panel === "help") renderPanel();
      });
      void refreshAgents();
      break;
    }
    case "request.closed": {
      state.requests = state.requests.map((r) => (r.id === ev.request.id ? { ...r, ...ev.request } : r));
      if (state.panel === "help") renderPanel();
      break;
    }
    case "agent.updated": {
      state.agents = state.agents.some((a) => a.id === ev.agent.id) ? state.agents.map((a) => (a.id === ev.agent.id ? ev.agent : a)) : [ev.agent, ...state.agents];
      const o = state.occupants.get(ev.agent.id);
      if (o) state.occupants.set(ev.agent.id, { ...o, agent: ev.agent });
      if (state.panel === "agents") renderPanel();
      break;
    }
    case "playbook.published":
      state.playbooks.unshift(ev.playbook);
      state.panelBadges.methods++;
      toast(`☰ ${ev.playbook.authorName} partage « ${ev.playbook.title} »`);
      renderPanelTabs();
      if (state.panel === "methods") renderPanel();
      void refreshAgents();
      break;
  }
}

async function refreshAgents() {
  try {
    state.agents = await api.agents();
    if (state.panel === "agents") renderPanel();
  } catch {
    /* ignore */
  }
}

async function loadLists() {
  const [skills, tasks, playbooks, agents, requests] = await Promise.all([api.skills(), api.tasks(), api.playbooks(), api.agents(), api.requests()]);
  state.skills = skills;
  state.tasks = tasks;
  state.playbooks = playbooks;
  state.agents = agents;
  state.requests = await Promise.all(requests.slice(0, 40).map((r) => api.request(r.id)));
  await refreshAnimator();
  renderPanel();
}

async function refreshAnimator() {
  try {
    const a = await api.animator();
    state.animator = "active" in a ? null : a;
    if (state.panel === "feed") renderPanel();
  } catch {
    /* ignore */
  }
}
setInterval(() => void refreshAnimator(), 15_000);

function setOnline(v: boolean) {
  state.online = v;
  statusEl.className = `status${v ? " online" : ""}`;
  statusEl.lastElementChild!.textContent = v ? "en direct" : "reconnexion…";
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    setOnline(true);
    void loadLists();
  };
  ws.onmessage = (e) => handleEvent(JSON.parse(e.data) as HotelEvent);
  ws.onclose = () => {
    setOnline(false);
    setTimeout(connect, 1500);
  };
  ws.onerror = () => ws.close();
}

renderPanelTabs();
connect();
