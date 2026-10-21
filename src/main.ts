import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';

export async function createApplication(logging = true) {
  const app = await NestFactory.create(AppModule, { logger: logging ? undefined : false });
  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableShutdownHooks();
  return app;
}

async function bootstrap(): Promise<void> {
  const rawPort = process.env.PORT ?? '8787';
  if (!/^\d+$/.test(rawPort) || Number(rawPort) > 65535) {
    throw new Error('PORT must be an integer between 0 and 65535');
  }
  const app = await createApplication();
  await app.listen(Number(rawPort), process.env.HOST ?? '0.0.0.0');
  const address = app.getHttpServer().address() as { port: number };
  Logger.log(`Yunkha signaling listening on port ${address.port}`, 'Bootstrap');
}

if (require.main === module) {
  void bootstrap().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
