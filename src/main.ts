import fsp from "node:fs/promises";
import Fastify from "fastify";
import cors from "@fastify/cors";
import env from "./env.js";
import { createServerContext } from "./server/context.js";
import { registerHttpRoutes } from "./server/http-routes.js";
import { registerWsRoutes } from "./server/ws-routes.js";

const app = Fastify({ logger: true });
app.register(cors, {
  origin: "*",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: "*",
});

const context = createServerContext();
registerHttpRoutes(app, context);
registerWsRoutes(app, context);

const start = async (): Promise<void> => {
  await fsp.mkdir(context.dataDir, { recursive: true });
  await fsp.mkdir(context.subtitlesDir, { recursive: true });

  try {
    await app.listen({
      host: env.HOST,
      port: env.PORT,
    });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

void start();
