import { Global, Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export const PG_CLIENT = Symbol('PG_CLIENT');
export const DRIZZLE = Symbol('DRIZZLE');

export type Database = PostgresJsDatabase<typeof schema>;

/**
 * Global database module. Provides the raw postgres-js client (PG_CLIENT, used
 * by the telemetry adapter's raw SQL) and the Drizzle instance (DRIZZLE) used
 * by every repository. casing:'snake_case' maps camelCase schema keys to the
 * snake_case columns the migrations create.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('database.url')!;
        return postgres(url, { max: 10 });
      },
    },
    {
      provide: DRIZZLE,
      inject: [PG_CLIENT],
      useFactory: (client: postgres.Sql) => drizzle(client, { schema, casing: 'snake_case' }),
    },
  ],
  exports: [PG_CLIENT, DRIZZLE],
})
export class DatabaseModule implements OnModuleDestroy {
  constructor(@Inject(PG_CLIENT) private readonly client: postgres.Sql) {}

  async onModuleDestroy(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }
}
