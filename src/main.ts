import { createApp } from "./app.js";
const app = await createApp();
await app.listen(
  Number(process.env.PORT ?? 8084),
  process.env.TALLY_BIND ?? "127.0.0.1",
);
console.log(
  JSON.stringify({
    event: "api_ready",
    port: Number(process.env.PORT ?? 8084),
    synthetic_only: true,
  }),
);
