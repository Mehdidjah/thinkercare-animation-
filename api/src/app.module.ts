import {Module} from '@nestjs/common';
import {AuthModule} from './auth/auth.module';
import {StorageModule} from './storage/storage.module';
import {TerrainModule} from './terrain/terrain.module';

// Security headers are a plain Express middleware registered in main.ts, ahead
// of static serving, so they also cover the SPA and its assets.
@Module({
  imports: [AuthModule, StorageModule, TerrainModule],
})
export class AppModule {}
