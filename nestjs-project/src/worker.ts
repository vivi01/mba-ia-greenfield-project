import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('VideoWorker');
  await NestFactory.createApplicationContext(AppModule);
  logger.log('Video worker started');
}
void bootstrap();
