import type { Agent, AnimatorStatus, HelpRequest, HelpRequestView, Playbook, RoomSummary, RoomView, SearchHit, Skill, Task } from "@hotel/shared";

import { HOTEL_URL } from "./config";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(HOTEL_URL + path);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  rooms: () => get<RoomSummary[]>("/api/rooms"),
  room: (id: string) => get<RoomView>(`/api/rooms/${encodeURIComponent(id)}`),
  skills: () => get<Skill[]>("/api/skills"),
  tasks: () => get<Task[]>("/api/tasks"),
  playbooks: () => get<Playbook[]>("/api/playbooks"),
  agents: () => get<Agent[]>("/api/agents"),
  animator: () => get<AnimatorStatus | { active: false }>("/api/animator"),
  requests: () => get<HelpRequest[]>("/api/requests"),
  request: (id: string) => get<HelpRequestView>(`/api/requests/${encodeURIComponent(id)}`),
  search: (q: string) => get<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}&limit=25`),
};
