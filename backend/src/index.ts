import { createApp } from "./app.js";
const app = createApp(),
  port = Number(process.env.PORT ?? 3000);
app.server.listen(port, "0.0.0.0", () =>
  console.log(`Kodelumi listening on :${port}`),
);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 10_000);
    timeout.unref();
    app
      .close()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(error);
        process.exit(1);
      });
  });
