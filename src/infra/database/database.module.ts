import { Global, Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export const PG_CLIENT = Symbol('PG_CLIENT');
export const DRIZZLE = Symbol('DRIZZLE');

export type Database = PostgresJsDatabase<typeof schema>;

/** The handle `db.transaction(...)` passes to its callback — same query API as `Database`. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** The pool or an open transaction — for repository writes that must join a caller's transaction. */
export type DbExecutor = Database | Transaction;

/**
 * Global database module. Provides the raw postgres-js client (PG_CLIENT, used
 * by the telemetry adapter's raw SQL) and the Drizzle instance (DRIZZLE) used
 * by every repository. casing:'snake_case' maps camelCase schema keys to the
 * snake_case columns the migrations create.
 *
 * postgres-js connects lazily and reconnects on the next query after a dropped
 * connection (queries in flight at that moment do fail). The explicit timeouts
 * below keep an unreachable database from holding requests for the library
 * default (30s connect timeout) and recycle idle connections so stale sockets
 * after a DB restart don't linger in the pool.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('database.url')!;
        return postgres(url, {
          max: 10,
          connect_timeout: 10, // seconds
          idle_timeout: 30, // seconds
        });
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
