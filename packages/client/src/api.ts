import type { Agent, AnimatorStatus, Playbook, RoomSummary, RoomView, Skill, Task } from "@hotel/shared";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
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
};
