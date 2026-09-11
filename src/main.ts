import path from "node:path";
import { loadConfig } from "./config.js";
import { loadOrCreatePepper, GryphonGateway } from "./gateway.js";
import { createAdminServer, createClientServer, createPublicServer, listenAdmin, listenTcp, listenUnix } from "./http.js";
import { GryphonRepository } from "./repository.js";

const config = loadConfig();
const repository = new GryphonRepository(path.join(config.dataDirectory, "gryphon.sqlite"));
const gateway = new GryphonGateway({ repository, config, pepper: loadOrCreatePepper(config.dataDirectory) });
await gateway.initialize();

const publicServer = createPublicServer(gateway, config);
const adminServer = createAdminServer(gateway);
const clientServer = createClientServer(gateway);
await Promise.all([
  listenTcp(publicServer, config.publicHost, config.publicPort),
  listenAdmin(adminServer, config.adminSocket),
  listenUnix(clientServer, config.clientSocket, 0o660),
]);

const timer = setInterval(() => { void gateway.drain(); }, 1_000);
timer.unref();
const maintenanceTimer = setInterval(() => { repository.maintain(new Date()); }, 60_000);
maintenanceTimer.unref();
const discoveryTimer = setInterval(() => { void gateway.initialize(); }, 5 * 60_000);
discoveryTimer.unref();

async function shutdown(): Promise<void> {
  clearInterval(timer);
  clearInterval(maintenanceTimer);
  clearInterval(discoveryTimer);
  await Promise.all([publicServer, adminServer, clientServer].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  repository.close();
}

process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
