import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {StorageModule} from '../storage/storage.module';
import {TerrainController} from './terrain.controller';
import {PhotosController} from './photos.controller';
import {TerrainService} from './terrain.service';
import {OperationsService} from './operations.service';
import {PhotosService} from './photos.service';

@Module({
  imports: [AuthModule, StorageModule],
  controllers: [TerrainController, PhotosController],
  providers: [TerrainService, OperationsService, PhotosService],
})
export class TerrainModule {}
