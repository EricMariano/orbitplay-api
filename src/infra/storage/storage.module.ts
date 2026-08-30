import { Global, Module } from '@nestjs/common';
import { STORAGE_PORT } from '../../shared/ports/storage.port';
import { MinioStorageAdapter } from './minio-storage.adapter';

@Global()
@Module({
  providers: [{ provide: STORAGE_PORT, useClass: MinioStorageAdapter }],
  exports: [STORAGE_PORT],
})
export class StorageModule {}
