import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { startInbox } from './agents/inbox';
import { config } from './config';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useBodyParser('json', { limit: '8mb' });
  app.enableCors({ origin: config.corsOrigins });
  await app.listen(config.port, '0.0.0.0');
  console.log(`workflow-poc-agentic server on http://localhost:${config.port}`);
  await startInbox();
}

bootstrap();
