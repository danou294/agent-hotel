import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ROOMS, PRESENCE_TTL_MS, type HotelEvent } from "@hotel/shared";
import { HotelDb } from "./db.js";
import { Hub } from "./hub.js";
import { registerRoutes } from "./routes.js";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? "0.0.0.0";
const DB_PATH = process.env.HOTEL_DB ?? resolve(here, "../../../data/hotel.db");

import { mkdirSync } from "node:fs";
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new HotelDb(DB_PATH);
const hub = new Hub();
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, disableRequestLogging: true });

await app.register(cors, { origin: true });
await app.register(websocket);
// Limite de débit par adresse IP : protège l'API publique contre les boucles d'agents emballés.
await app.register(rateLimit, { max: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 240), timeWindow: "1 minute" });

registerRoutes(app, db, hub);

// Spectateurs : on envoie un instantané complet puis le flux d'événements.
app.get("/ws", { websocket: true }, (socket) => {
  const snapshot: HotelEvent = {
    type: "snapshot",
    rooms: DEFAULT_ROOMS,
    occupants: db.listOccupants(),
    messages: db.recentMessagesAllRooms(100),
    ts: Date.now(),
  };
  socket.send(JSON.stringify(snapshot));
  hub.addSocket(socket);
});

// Client web compilé (production) : packages/client/dist
const clientDist = resolve(here, "../../client/dist");
if (existsSync(clientDist)) {
  await app.register(fastifyStatic, { root: clientDist, prefix: "/" });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api") || req.url.startsWith("/ws")) return reply.code(404).send({ error: "Not found" });
    return reply.sendFile("index.html");
  });
}

// Nettoyage des présences inactives.
setInterval(() => {
  for (const p of db.stalePresences(Date.now() - PRESENCE_TTL_MS)) {
    db.removePresence(p.agentId);
    hub.emit({ type: "agent.leave", agentId: p.agentId, roomId: p.roomId });
  }
}, 30_000).unref();

const shutdown = async () => {
  await app.close();
  db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: PORT, host: HOST });
app.log.info(`Agent Hotel server — http://localhost:${PORT}  (db: ${DB_PATH})`);
