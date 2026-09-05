import 'dotenv/config';
import * as argon2 from 'argon2';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

/**
 * Deterministic, idempotent seed — part of the architecture, not a convenience.
 * Without the plug-in / desktop app / payments, this is the ONLY source of data
 * for building reports later. Re-running it is safe (onConflictDoNothing).
 *
 * Org model (decision §1.1): one organization (studio) with four members, one
 * per role. All four share the documented demo password below.
 */

// Fixed ids → deterministic across runs.
export const ORG_ID = '01920000-0000-7000-8000-0000000000a1';
const ROLE_IDS = {
  owner: '01920000-0000-7000-8000-0000000000b1',
  admin: '01920000-0000-7000-8000-0000000000b2',
  studio: '01920000-0000-7000-8000-0000000000b3',
  player: '01920000-0000-7000-8000-0000000000b4',
} as const;
export const USER_IDS = {
  owner: '01920000-0000-7000-8000-0000000000c1',
  admin: '01920000-0000-7000-8000-0000000000c2',
  studio: '01920000-0000-7000-8000-0000000000c3',
  player: '01920000-0000-7000-8000-0000000000c4',
} as const;
export const GAME_IDS = {
  one: '01920000-0000-7000-8000-0000000000d1',
  two: '01920000-0000-7000-8000-0000000000d2',
} as const;

export const SEED_EMAILS = {
  owner: 'owner@orbitplay.dev',
  admin: 'admin@orbitplay.dev',
  studio: 'studio@orbitplay.dev',
  player: 'player@orbitplay.dev',
} as const;

export const SEED_PASSWORD = 'Orbit@Demo123';

export async function seedDatabase(databaseUrl: string, quiet = false): Promise<void> {
  const log = (msg: string) => {
    if (!quiet) console.log(msg);
  };
  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client, { schema, casing: 'snake_case' });

  try {
    const passwordHash = await argon2.hash(SEED_PASSWORD, { type: argon2.argon2id });

    // 1) Roles
    await db
      .insert(schema.roles)
      .values([
        { id: ROLE_IDS.owner, key: 'owner', label: 'Owner' },
        { id: ROLE_IDS.admin, key: 'admin', label: 'Admin' },
        { id: ROLE_IDS.studio, key: 'studio', label: 'Estúdio' },
        { id: ROLE_IDS.player, key: 'player', label: 'Jogador' },
      ])
      .onConflictDoNothing();

    // 2) Users (one per role)
    await db
      .insert(schema.users)
      .values([
        {
          id: USER_IDS.owner,
          email: 'owner@orbitplay.dev',
          passwordHash,
          displayName: 'Olivia Owner',
          birthdate: '1990-01-01',
        },
        {
          id: USER_IDS.admin,
          email: 'admin@orbitplay.dev',
          passwordHash,
          displayName: 'Adam Admin',
          birthdate: '1990-01-01',
        },
        {
          id: USER_IDS.studio,
          email: 'studio@orbitplay.dev',
          passwordHash,
          displayName: 'Sofia Studio',
          birthdate: '1990-01-01',
        },
        {
          id: USER_IDS.player,
          email: 'player@orbitplay.dev',
          passwordHash,
          displayName: 'Pedro Player',
          birthdate: '1995-06-15',
        },
      ])
      .onConflictDoNothing();

    // 3) Organization (owned by the owner user)
    await db
      .insert(schema.organizations)
      .values({
        id: ORG_ID,
        name: 'OrbitPlay Studio Demo',
        slug: 'orbitplay-studio-demo',
        ownerUserId: USER_IDS.owner,
      })
      .onConflictDoNothing();

    // 4) Memberships (each user → org with their role)
    await db
      .insert(schema.memberships)
      .values([
        { organizationId: ORG_ID, userId: USER_IDS.owner, roleId: ROLE_IDS.owner },
        { organizationId: ORG_ID, userId: USER_IDS.admin, roleId: ROLE_IDS.admin },
        { organizationId: ORG_ID, userId: USER_IDS.studio, roleId: ROLE_IDS.studio },
        { organizationId: ORG_ID, userId: USER_IDS.player, roleId: ROLE_IDS.player },
      ])
      .onConflictDoNothing();

    // 5) Two games with metadata
    await db
      .insert(schema.games)
      .values([
        {
          id: GAME_IDS.one,
          organizationId: ORG_ID,
          title: 'Nebula Drift',
          slug: 'nebula-drift',
          description: 'Corrida espacial arcade para testar sensação de velocidade.',
          genre: 'Arcade Racing',
          platform: 'PC',
          status: 'active',
        },
        {
          id: GAME_IDS.two,
          organizationId: ORG_ID,
          title: 'Hollow Keep',
          slug: 'hollow-keep',
          description: 'Metroidvania sombrio para avaliar curva de dificuldade.',
          genre: 'Metroidvania',
          platform: 'PC',
          status: 'draft',
        },
      ])
      .onConflictDoNothing();

    log('✓ seed complete');
    log('  Organization: OrbitPlay Studio Demo');
    log(`  Password for ALL seed users: ${SEED_PASSWORD}`);
    log(
      '  owner@orbitplay.dev · admin@orbitplay.dev · studio@orbitplay.dev · player@orbitplay.dev',
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function seed(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to seed');
  await seedDatabase(url);
}

// Only run when invoked directly (pnpm db:seed), not when imported by tests.
if (require.main === module) {
  seed().catch((err) => {
    console.error('✗ seed failed');
    console.error(err);
    process.exit(1);
  });
}
