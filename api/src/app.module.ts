import {Module, type MiddlewareConsumer, type NestModule} from '@nestjs/common';
import {AuthModule} from './auth/auth.module';
import {StorageModule} from './storage/storage.module';
import {TerrainModule} from './terrain/terrain.module';
import {SecurityHeadersMiddleware} from './common/security-headers.middleware';

@Module({
  imports: [AuthModule, StorageModule, TerrainModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Security headers on every response (CSP frame-ancestors 'none',
    // X-Frame-Options DENY, no-store/noindex on /api).
    consumer.apply(SecurityHeadersMiddleware).forRoutes('*');
  }
}
