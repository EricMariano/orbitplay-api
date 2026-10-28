-- MANUAL migration: the role catalog (owner/admin/studio/player).
--
-- WHY THIS IS NOT GENERATED: it's reference data the app can't run without,
-- and drizzle-kit only emits DDL. Signup, invites and every role check need
-- these four rows; before this they only came from `pnpm db:seed`, which also
-- creates demo accounts with a public password — so a fresh production
-- database either failed every signup or got those accounts. The catalog now
-- comes with the migrations, and the seed refuses to run in production.
--
-- Same ids, keys and labels as ROLE_IDS in src/infra/database/seed.ts, so
-- whichever runs first, each role ends up as a single row.
INSERT INTO roles (id, key, label) VALUES
  ('01920000-0000-7000-8000-0000000000b1', 'owner', 'Owner'),
  ('01920000-0000-7000-8000-0000000000b2', 'admin', 'Admin'),
  ('01920000-0000-7000-8000-0000000000b3', 'studio', 'Estúdio'),
  ('01920000-0000-7000-8000-0000000000b4', 'player', 'Jogador')
ON CONFLICT DO NOTHING;
