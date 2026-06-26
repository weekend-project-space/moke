import { createApp } from './app.js';

async function main() {
  const app = await createApp();

  process.once('SIGINT', () => {
    void app.close();
  });
  process.once('SIGTERM', () => {
    void app.close();
  });

  app.server.listen(app.port, () => {
    console.log(`Agent Server listening on http://127.0.0.1:${app.port}`);
  });
}

void main();
