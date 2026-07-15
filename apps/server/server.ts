import { createApp } from './app.js';

async function main() {
  const app = await createApp();
  let shuttingDown = false;

  const shutdown = async (reason: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`Shutting down Agent Server (${reason})...`);
    const forceExitTimer = setTimeout(() => {
      console.error('Agent Server shutdown timed out.');
      process.exit(1);
    }, 5000);
    forceExitTimer.unref();

    try {
      await app.close();
      clearTimeout(forceExitTimer);
      process.exit(exitCode);
    } catch (error) {
      clearTimeout(forceExitTimer);
      console.error('Failed to shut down Agent Server:', error);
      process.exit(1);
    }
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  app.server.once('error', (error) => {
    console.error('Agent Server failed:', error);
    void shutdown('server error', 1);
  });

  app.server.listen(app.port, () => {
    console.log(`Agent Server listening on http://127.0.0.1:${app.port}`);
  });
}

void main().catch((error) => {
  console.error('Failed to start Agent Server:', error);
  process.exit(1);
});
