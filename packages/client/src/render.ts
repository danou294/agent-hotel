import type { Furniture, Occupant, Room } from "@hotel/shared";

export const TILE_W = 64;
export const TILE_H = 32;
const WALL_H = 96;
const WALK_SPEED = 3.2; // tuiles par seconde

export interface AvatarState {
  occupant: Occupant;
  rx: number; // position rendue (interpolée)
  ry: number;
  tx: number; // cible
  ty: number;
  bubble?: { text: string; until: number };
  lastMoveAt: number;
}

interface HitBox {
  agentId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, ((n >> 16) & 255) + amount));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amount));
  const b = Math.max(0, Math.min(255, (n & 255) + amount));
  return `rgb(${r},${g},${b})`;
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines.slice(0, 6);
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private room: Room | null = null;
  private avatars = new Map<string, AvatarState>();
  private hits: HitBox[] = [];
  private lastFrame = performance.now();
  private ox = 0;
  private oy = 0;
  onAgentClick: ((agentId: string, screenX: number, screenY: number) => void) | null = null;
  onEmptyClick: (() => void) | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
    canvas.addEventListener("click", (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      for (let i = this.hits.length - 1; i >= 0; i--) {
        const h = this.hits[i];
        if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) {
          this.onAgentClick?.(h.agentId, e.clientX, e.clientY);
          return;
        }
      }
      this.onEmptyClick?.();
    });
    canvas.addEventListener("mousemove", (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      canvas.style.cursor = this.hits.some((h) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) ? "pointer" : "default";
    });
    requestAnimationFrame((t) => this.frame(t));
  }

  setRoom(room: Room, occupants: Occupant[]) {
    this.room = room;
    this.avatars.clear();
    for (const o of occupants) this.addOccupant(o);
  }

  addOccupant(o: Occupant) {
    const existing = this.avatars.get(o.agentId);
    if (existing) {
      existing.occupant = o;
      existing.tx = o.x;
      existing.ty = o.y;
      return;
    }
    this.avatars.set(o.agentId, { occupant: o, rx: o.x, ry: o.y, tx: o.x, ty: o.y, lastMoveAt: 0 });
  }

  removeOccupant(agentId: string) {
    this.avatars.delete(agentId);
  }

  moveOccupant(agentId: string, x: number, y: number) {
    const a = this.avatars.get(agentId);
    if (!a) return;
    a.tx = x;
    a.ty = y;
    a.occupant = { ...a.occupant, x, y };
    a.lastMoveAt = performance.now();
  }

  say(agentId: string, text: string) {
    const a = this.avatars.get(agentId);
    if (!a) return;
    a.bubble = { text, until: performance.now() + 7000 + Math.min(5000, text.length * 25) };
  }

  hasAvatar(agentId: string) {
    return this.avatars.has(agentId);
  }

  // ------------------------------------------------------------ géométrie

  private tileCenter(x: number, y: number): [number, number] {
    return [this.ox + ((x - y) * TILE_W) / 2, this.oy + ((x + y) * TILE_H) / 2 + TILE_H / 2];
  }

  private footprint(x: number, y: number, w: number, h: number): [number, number][] {
    const top: [number, number] = [this.ox + ((x - y) * TILE_W) / 2, this.oy + ((x + y) * TILE_H) / 2];
    const right: [number, number] = [this.ox + ((x + w - 1 - y) * TILE_W) / 2 + TILE_W / 2, this.oy + ((x + w - 1 + y) * TILE_H) / 2 + TILE_H / 2];
    const bottom: [number, number] = [this.ox + ((x + w - 1 - (y + h - 1)) * TILE_W) / 2, this.oy + ((x + w - 1 + y + h - 1) * TILE_H) / 2 + TILE_H];
    const left: [number, number] = [this.ox + ((x - (y + h - 1)) * TILE_W) / 2 - TILE_W / 2, this.oy + ((x + y + h - 1) * TILE_H) / 2 + TILE_H / 2];
    return [top, right, bottom, left];
  }

  private poly(points: [number, number][], fill: string, stroke?: string) {
    const c = this.ctx;
    c.beginPath();
    c.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) c.lineTo(points[i][0], points[i][1]);
    c.closePath();
    c.fillStyle = fill;
    c.fill();
    if (stroke) {
      c.strokeStyle = stroke;
      c.lineWidth = 1;
      c.stroke();
    }
  }

  /** Cuboïde isométrique couvrant les tuiles [x..x+w-1] × [y..y+h-1]. */
  private box(x: number, y: number, w: number, h: number, height: number, color: string) {
    const [top, right, bottom, left] = this.footprint(x, y, w, h);
    const up = (p: [number, number]): [number, number] => [p[0], p[1] - height];
    this.poly([up(left), up(bottom), bottom, left], shade(color, -35), "#00000055"); // face gauche
    this.poly([up(bottom), up(right), right, bottom], shade(color, -70), "#00000055"); // face droite
    this.poly([up(top), up(right), up(bottom), up(left)], shade(color, 10), "#00000055"); // dessus
  }

  // ---------------------------------------------------------------- frame

  private frame(now: number) {
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.resize();
    const c = this.ctx;
    const W = this.canvas.width / devicePixelRatio;
    const H = this.canvas.height / devicePixelRatio;
    c.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    c.clearRect(0, 0, W, H);
    c.imageSmoothingEnabled = false;
    this.hits = [];

    const room = this.room;
    if (!room) {
      requestAnimationFrame((t) => this.frame(t));
      return;
    }

    const totalH = ((room.width + room.height) * TILE_H) / 2 + WALL_H;
    this.ox = W / 2 - ((room.width - room.height) * TILE_W) / 4;
    this.oy = (H - totalH) / 2 + WALL_H + 20;

    this.drawWalls(room);
    this.drawFloor(room);
    for (const f of room.furniture) if (f.kind === "rug") this.drawRug(f);

    // interpolation des déplacements
    for (const a of this.avatars.values()) {
      const dx = a.tx - a.rx;
      const dy = a.ty - a.ry;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.001) {
        const step = Math.min(dist, WALK_SPEED * dt);
        a.rx += (dx / dist) * step;
        a.ry += (dy / dist) * step;
      } else {
        a.rx = a.tx;
        a.ry = a.ty;
      }
    }

    type Entity = { depth: number; draw: () => void };
    const entities: Entity[] = [];
    for (const f of room.furniture) {
      if (f.kind === "rug") continue;
      const w = f.w ?? 1;
      const h = f.h ?? 1;
      entities.push({ depth: f.x + w - 1 + f.y + h - 1 + 0.5, draw: () => this.drawFurniture(f) });
    }
    for (const a of this.avatars.values()) {
      entities.push({ depth: a.rx + a.ry + 0.6, draw: () => this.drawAvatar(a, now) });
    }
    entities.sort((p, q) => p.depth - q.depth);
    for (const e of entities) e.draw();

    // bulles par-dessus tout
    for (const a of this.avatars.values()) if (a.bubble && a.bubble.until > now) this.drawBubble(a);
    for (const a of this.avatars.values()) if (a.bubble && a.bubble.until <= now) a.bubble = undefined;

    requestAnimationFrame((t) => this.frame(t));
  }

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.round(rect.width * devicePixelRatio);
    const h = Math.round(rect.height * devicePixelRatio);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private drawWalls(room: Room) {
    const [top] = this.footprint(0, 0, 1, 1);
    const [, , , leftFar] = this.footprint(0, room.height - 1, 1, 1);
    const [, rightFar] = this.footprint(room.width - 1, 0, 1, 1);
    const up = (p: [number, number]): [number, number] => [p[0], p[1] - WALL_H];
    this.poly([up(leftFar), up(top), top, leftFar], room.wall, "#00000066");
    this.poly([up(top), up(rightFar), rightFar, top], shade(room.wall, -30), "#00000066");
    // plinthe
    const c = this.ctx;
    c.strokeStyle = shade(room.wall, -60);
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(leftFar[0], leftFar[1]);
    c.lineTo(top[0], top[1]);
    c.lineTo(rightFar[0], rightFar[1]);
    c.stroke();
  }

  private drawFloor(room: Room) {
    for (let y = 0; y < room.height; y++) {
      for (let x = 0; x < room.width; x++) {
        const pts = this.footprint(x, y, 1, 1);
        const col = (x + y) % 2 === 0 ? room.floor : shade(room.floor, -12);
        this.poly(pts, col, shade(room.floor, -45));
      }
    }
  }

  private drawRug(f: Furniture) {
    const pts = this.footprint(f.x, f.y, f.w ?? 1, f.h ?? 1);
    this.poly(pts, "#b23a48", "#6b1f28");
    const inner = pts.map((p, i) => {
      const cx = (pts[0][0] + pts[2][0]) / 2;
      const cy = (pts[0][1] + pts[2][1]) / 2;
      return [cx + (p[0] - cx) * 0.75, cy + (p[1] - cy) * 0.75] as [number, number];
    });
    void inner[0];
    this.poly(inner, "#d9535f", "#6b1f28");
  }

  private drawFurniture(f: Furniture) {
    const w = f.w ?? 1;
    const h = f.h ?? 1;
    const c = this.ctx;
    const [top, , bottom] = this.footprint(f.x, f.y, w, h);
    const cx = (top[0] + bottom[0]) / 2;
    let labelY = top[1];
    switch (f.kind) {
      case "desk": {
        this.box(f.x, f.y, w, h, 26, "#8b5a2b");
        // petit écran sur le bureau
        const [tc] = [this.tileCenter(f.x, f.y)];
        c.fillStyle = "#1b2330";
        c.fillRect(tc[0] - 10, tc[1] - 26 - 18, 20, 14);
        c.fillStyle = "#4dabf7";
        c.fillRect(tc[0] - 8, tc[1] - 26 - 16, 16, 10);
        labelY = top[1] - 26;
        break;
      }
      case "counter":
        this.box(f.x, f.y, w, h, 40, "#a0522d");
        labelY = top[1] - 40;
        break;
      case "shelf": {
        this.box(f.x, f.y, w, h, 72, "#6f4a2a");
        // livres sur la face gauche
        const [, , b, l] = this.footprint(f.x, f.y, w, h);
        const colors = ["#ff6b6b", "#4dabf7", "#ffd43b", "#69db7c", "#da77f2", "#ffa94d"];
        for (let i = 0; i < 8; i++) {
          const t = (i + 0.5) / 8;
          const px = l[0] + (b[0] - l[0]) * t;
          const py = l[1] + (b[1] - l[1]) * t;
          c.fillStyle = colors[i % colors.length];
          c.fillRect(px - 3, py - 62, 6, 18);
          c.fillRect(px - 3, py - 38, 6, 16);
        }
        labelY = top[1] - 72;
        break;
      }
      case "board": {
        this.box(f.x, f.y, w, h, 60, "#3b4a3a");
        const [, , b, l] = this.footprint(f.x, f.y, w, h);
        // notes épinglées
        const notes = ["#ffd43b", "#ff8787", "#74c0fc", "#8ce99a"];
        for (let i = 0; i < 4; i++) {
          const t = (i + 0.5) / 4;
          const px = l[0] + (b[0] - l[0]) * t;
          const py = l[1] + (b[1] - l[1]) * t;
          c.fillStyle = notes[i];
          c.fillRect(px - 6, py - 50 + (i % 2) * 14, 12, 12);
        }
        labelY = top[1] - 60;
        break;
      }
      case "plant": {
        const [tx, ty] = this.tileCenter(f.x, f.y);
        this.box(f.x, f.y, 1, 1, 14, "#b5651d");
        c.fillStyle = "#2f9e44";
        c.beginPath();
        c.arc(tx, ty - 32, 16, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = "#51cf66";
        c.beginPath();
        c.arc(tx - 8, ty - 40, 10, 0, Math.PI * 2);
        c.arc(tx + 9, ty - 38, 9, 0, Math.PI * 2);
        c.fill();
        labelY = ty - 56;
        break;
      }
      case "lamp": {
        const [tx, ty] = this.tileCenter(f.x, f.y);
        c.fillStyle = "#444";
        c.fillRect(tx - 2, ty - 70, 4, 68);
        c.fillStyle = "#333";
        c.fillRect(tx - 8, ty - 4, 16, 5);
        const g = c.createRadialGradient(tx, ty - 74, 2, tx, ty - 74, 28);
        g.addColorStop(0, "rgba(255, 230, 120, 0.9)");
        g.addColorStop(1, "rgba(255, 230, 120, 0)");
        c.fillStyle = g;
        c.beginPath();
        c.arc(tx, ty - 74, 28, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = "#ffe066";
        c.fillRect(tx - 6, ty - 80, 12, 10);
        labelY = ty - 90;
        break;
      }
      case "rug":
        break;
    }
    if (f.label) {
      c.font = "600 12px 'Pixelify Sans', sans-serif";
      c.textAlign = "center";
      c.fillStyle = "rgba(0,0,0,0.55)";
      const tw = c.measureText(f.label).width;
      c.fillRect(cx - tw / 2 - 5, labelY - 18, tw + 10, 16);
      c.fillStyle = "#fff";
      c.fillText(f.label, cx, labelY - 6);
    }
  }

  private drawAvatar(a: AvatarState, now: number) {
    const c = this.ctx;
    const [sx, sy] = this.tileCenter(a.rx, a.ry);
    const walking = Math.hypot(a.tx - a.rx, a.ty - a.ry) > 0.01;
    const bob = walking ? Math.round(Math.sin(now / 90) * 2) : 0;
    const u = 3; // taille d'un "pixel"
    const color = a.occupant.agent.color;
    const skin = "#f3c9a0";
    const feetY = sy + 2;

    // ombre
    c.fillStyle = "rgba(0,0,0,0.35)";
    c.beginPath();
    c.ellipse(sx, sy + 2, 14, 6, 0, 0, Math.PI * 2);
    c.fill();

    const px = (x: number, y: number, w: number, h: number, col: string) => {
      c.fillStyle = col;
      c.fillRect(Math.round(sx + x * u), Math.round(feetY + y * u + bob), w * u, h * u);
    };
    // jambes
    const legSwing = walking ? (Math.sin(now / 90) > 0 ? 1 : -1) : 0;
    px(-3, -6 + legSwing, 2, 6 - legSwing, "#2b2b3a");
    px(1, -6 - legSwing, 2, 6 + legSwing, "#2b2b3a");
    // corps
    px(-4, -15, 8, 9, color);
    px(-4, -15, 8, 1, shade(color, 40));
    // bras
    px(-6, -14, 2, 7, shade(color, -20));
    px(4, -14, 2, 7, shade(color, -20));
    px(-6, -8, 2, 2, skin);
    px(4, -8, 2, 2, skin);
    // tête
    px(-4, -24, 8, 8, skin);
    px(-4, -24, 8, 2, "#5a3a1e"); // cheveux
    // yeux
    px(-2, -21, 1, 1, "#111");
    px(1, -21, 1, 1, "#111");
    // bouche
    px(-1, -18, 2, 1, "#b0553c");
    // chapeau
    switch (a.occupant.agent.hat) {
      case "cap":
        px(-5, -26, 10, 2, shade(color, -30));
        px(2, -24, 5, 1, shade(color, -30));
        break;
      case "antenna":
        px(-1, -30, 1, 6, "#999");
        px(-2, -32, 3, 2, "#ff6b6b");
        break;
      case "crown":
        px(-4, -27, 8, 3, "#ffd43b");
        px(-4, -29, 2, 2, "#ffd43b");
        px(-1, -29, 2, 2, "#ffd43b");
        px(2, -29, 2, 2, "#ffd43b");
        break;
      case "halo":
        c.strokeStyle = "#fff3bf";
        c.lineWidth = 2;
        c.beginPath();
        c.ellipse(sx, feetY - 28 * u + bob, 14, 5, 0, 0, Math.PI * 2);
        c.stroke();
        break;
      case "beanie":
        px(-4, -27, 8, 3, "#5c7cfa");
        px(-1, -29, 2, 2, "#fff");
        break;
    }

    // étiquette nom
    const name = a.occupant.agent.name;
    c.font = "600 13px 'Pixelify Sans', sans-serif";
    c.textAlign = "center";
    const tw = c.measureText(name).width;
    const tagY = feetY - 27 * u - 20 + bob;
    c.fillStyle = "rgba(0,0,0,0.65)";
    c.fillRect(sx - tw / 2 - 6, tagY - 12, tw + 12, 17);
    c.fillStyle = color;
    c.fillRect(sx - tw / 2 - 6, tagY - 12, 3, 17);
    c.fillStyle = "#fff";
    c.fillText(name, sx + 1, tagY + 1);

    this.hits.push({ agentId: a.occupant.agentId, x: sx - 20, y: tagY - 14, w: 40, h: 27 * u + 20 });
  }

  private drawBubble(a: AvatarState) {
    const c = this.ctx;
    const [sx, sy] = this.tileCenter(a.rx, a.ry);
    c.font = "14px 'Pixelify Sans', sans-serif";
    const lines = wrapText(c, a.bubble!.text, 200);
    const lineH = 17;
    const padding = 8;
    const w = Math.max(...lines.map((l) => c.measureText(l).width)) + padding * 2;
    const h = lines.length * lineH + padding * 2 - 4;
    const top = sy - 27 * 3 - 36 - h;
    const left = Math.max(8, Math.min(this.canvas.width / devicePixelRatio - w - 8, sx - w / 2));
    c.fillStyle = "#fffdf5";
    c.strokeStyle = "#222";
    c.lineWidth = 2;
    c.beginPath();
    c.roundRect(left, top, w, h, 6);
    c.fill();
    c.stroke();
    // queue
    c.beginPath();
    c.moveTo(sx - 6, top + h);
    c.lineTo(sx, top + h + 8);
    c.lineTo(sx + 6, top + h);
    c.closePath();
    c.fillStyle = "#fffdf5";
    c.fill();
    c.strokeStyle = "#222";
    c.beginPath();
    c.moveTo(sx - 6, top + h);
    c.lineTo(sx, top + h + 8);
    c.lineTo(sx + 6, top + h);
    c.stroke();
    c.fillStyle = "#1a1a1a";
    c.textAlign = "left";
    lines.forEach((l, i) => c.fillText(l, left + padding, top + padding + 12 + i * lineH));
  }
}
