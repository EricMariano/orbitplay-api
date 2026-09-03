-- =============================================================================
-- OrbitPlay — schema para DIAGRAMAÇÃO (dbdiagram.io)
--
-- ⚠️  NÃO EXECUTE ESTE ARQUIVO CONTRA O BANCO.
--
-- A fonte da verdade do schema é o TypeScript em src/infra/database/schema/,
-- e as migrações são GERADAS (`pnpm db:generate`). Rodar este SQL direto
-- criaria as tabelas por fora do journal do Drizzle e deixaria o histórico
-- de migração inconsistente — proibido em AGENTS.md.
--
-- Este arquivo existe só para colar em: dbdiagram.io → Import → From PostgreSQL
--
-- Derivado de docs/DATA-MODEL.md e docs/DER.md.
-- Escopo: plataforma. Pagamento, carteira, boost, insights e transcrição estão
-- deferidos (BACKEND-SPEC §10) e não aparecem aqui.
--
-- Legenda nos comentários:
--   [existe]            já criada e em uso
--   [criada, sem uso]   existe, nenhum código a consome
--   [novo]              a criar
--   [congelada]         dormente, contrato imutável (SDK e builds publicadas)
-- =============================================================================


-- =============================================================================
-- ENUMS
-- =============================================================================

-- já existentes
CREATE TYPE membership_status AS ENUM ('active', 'invited', 'disabled');
CREATE TYPE game_status       AS ENUM ('draft', 'active', 'archived');
CREATE TYPE trigger_type      AS ENUM ('counter', 'timer', 'ui_event', 'vector', 'input');

-- a criar
CREATE TYPE test_status          AS ENUM ('draft', 'published', 'paused', 'finished', 'expired');
CREATE TYPE wizard_step          AS ENUM ('model', 'form', 'build', 'audience', 'review');
CREATE TYPE test_model_key       AS ENUM ('free_exploration_telemetry', 'free_exploration', 'ab_test', 'ab_test_images');
CREATE TYPE question_type        AS ENUM ('scale', 'single_choice', 'multiple_choice', 'open_text', 'boolean', 'nps');
CREATE TYPE build_status         AS ENUM ('awaiting_upload', 'uploading', 'processing', 'validated', 'failed');
CREATE TYPE build_step_key       AS ENUM ('checksum', 'malware_scan', 'metadata', 'plugin_manifest');
CREATE TYPE processing_status    AS ENUM ('processing', 'ready', 'failed', 'unavailable');
CREATE TYPE participation_status AS ENUM ('reserved', 'tutorial', 'downloading', 'ready', 'playing', 'form_pending', 'in_review', 'completed', 'rejected', 'abandoned');
CREATE TYPE session_status       AS ENUM ('starting', 'recording', 'paused', 'finishing', 'processing', 'completed', 'invalidated');
CREATE TYPE recording_kind       AS ENUM ('screen', 'webcam', 'microphone');
CREATE TYPE asset_kind           AS ENUM ('cover', 'banner', 'screenshot');
CREATE TYPE post_status          AS ENUM ('visible', 'hidden', 'removed');
CREATE TYPE report_stage         AS ENUM ('none', 'partial', 'final');


-- =============================================================================
-- AUTH E TENANCY
-- =============================================================================

CREATE TABLE users (
  id            uuid PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name  text NOT NULL,
  birthdate     date NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
COMMENT ON TABLE  users IS '[existe] Conta global, sem organization_id. Uma pessoa pode ser membro de varias organizacoes.';
COMMENT ON COLUMN users.password_hash IS 'argon2. Nunca retornado, exibido ou logado.';
COMMENT ON COLUMN users.birthdate IS 'Plataforma e 18+. Idade validada no servidor no cadastro.';
COMMENT ON COLUMN users.deleted_at IS 'Desativacao logica preferida a exclusao quando ha historico.';

CREATE TABLE organizations (
  id            uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users (id),
  name          text NOT NULL,
  slug          text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
COMMENT ON TABLE  organizations IS '[existe] Fronteira de tenancy. Todo dado do estudio pendura aqui.';
COMMENT ON COLUMN organizations.owner_user_id IS 'Nunca pode ficar sem owner ativo: rebaixar o ultimo owner responde 409.';

CREATE TABLE roles (
  id  uuid PRIMARY KEY,
  key text NOT NULL UNIQUE
);
COMMENT ON TABLE roles IS '[existe] owner | admin | studio | player';

CREATE TABLE memberships (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  role_id         uuid NOT NULL REFERENCES roles (id),
  status          membership_status NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE  memberships IS '[existe] Liga usuario a organizacao com um papel.';
COMMENT ON COLUMN memberships.role_id IS 'O papel que vale na requisicao vem daqui, carregado no access token. Nunca do corpo.';

CREATE TABLE refresh_tokens (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE refresh_tokens IS '[existe] Rotacao a cada refresh, com deteccao de reuso.';

CREATE TABLE password_reset_tokens (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE password_reset_tokens IS '[existe] Token de uso unico para POST /auth/password/forgot e /auth/password/reset.';
COMMENT ON COLUMN password_reset_tokens.used_at IS 'Uso unico. Redefinir invalida as sessoes ativas do usuario.';

CREATE TABLE audit_log (
  id              uuid PRIMARY KEY,
  organization_id uuid REFERENCES organizations (id) ON DELETE CASCADE,
  actor_user_id   uuid REFERENCES users (id),
  action          text NOT NULL,
  entity_type     text,
  entity_id       uuid,
  metadata        jsonb,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE audit_log IS '[existe, falta expor] Obrigatorio em mudanca de papel/status, exclusao, publicacao/encerramento de teste e invalidacao de sessao.';


-- =============================================================================
-- JOGO, TESTE E BUILD
-- =============================================================================

CREATE TABLE games (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  title           text NOT NULL,
  slug            text NOT NULL,
  description     text,
  genre           text,
  platform        text,
  status          game_status NOT NULL DEFAULT 'draft',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
COMMENT ON COLUMN games.organization_id IS 'Chave de tenancy, aplicada pelo BaseRepository. Servico nunca filtra a mao.';
CREATE UNIQUE INDEX games_org_slug_unique ON games (organization_id, slug);

CREATE TABLE game_assets (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  game_id         uuid NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  kind            asset_kind NOT NULL,
  storage_key     text NOT NULL,
  content_type    text,
  size_bytes      bigint,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
COMMENT ON TABLE  game_assets IS '[criada, sem uso] Tabela existe e NENHUMA linha de codigo a consome. Upload de capa/banner da Tela 04 e trabalho novo de ponta a ponta.';
COMMENT ON COLUMN game_assets.storage_key IS 'Bytes no MinIO. Formato e tamanho validados no backend, nao no front.';

CREATE TABLE tests (
  id                      uuid PRIMARY KEY,
  organization_id         uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  game_id                 uuid NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  name                    text,
  model_key               test_model_key NOT NULL,
  status                  test_status NOT NULL DEFAULT 'draft',
  current_step            wizard_step NOT NULL DEFAULT 'model',
  slots_total             integer NOT NULL DEFAULT 0,
  slots_taken             integer NOT NULL DEFAULT 0,
  duration_days           integer,
  starts_at               timestamptz,
  ends_at                 timestamptz,
  published_at            timestamptz,
  publish_idempotency_key text UNIQUE,
  reward_amount_cents     integer,
  reward_currency         text,
  report_stage            report_stage NOT NULL DEFAULT 'none',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE  tests IS '[novo] Centro do dominio. Nasce draft e o wizard e um rascunho persistido no servidor.';
COMMENT ON COLUMN tests.current_step IS 'Voltar entre etapas do wizard nao pode perder dados.';
COMMENT ON COLUMN tests.slots_taken IS 'CONTADOR CONCORRENTE. Use UPDATE ... WHERE slots_taken < slots_total checando linhas afetadas. Nunca SELECT seguido de UPDATE.';
COMMENT ON COLUMN tests.publish_idempotency_key IS 'UNIQUE. E o que faz recarregar nao criar um segundo teste (Tela 10 RN-02).';
COMMENT ON COLUMN tests.reward_amount_cents IS 'Valor devido ao tester. Registrado agora mesmo sem carteira: e o dado que a carteira consome quando entrar.';
COMMENT ON COLUMN tests.report_stage IS 'Controla o botao de relatorio: parcial quando ha dados, final so com processamento concluido.';
CREATE INDEX tests_org_idx ON tests (organization_id);
CREATE INDEX tests_game_status_idx ON tests (game_id, status);
CREATE INDEX tests_feed_idx ON tests (status, ends_at);

CREATE TABLE test_audience_criteria (
  test_id         uuid PRIMARY KEY REFERENCES tests (id) ON DELETE CASCADE,
  countries       text[],
  archetypes      text[],
  platforms       text[],
  age_min         integer,
  age_max         integer,
  tester_count    integer,
  keep_active     boolean NOT NULL DEFAULT true,
  estimated_reach integer
);
COMMENT ON COLUMN test_audience_criteria.age_min IS 'Minimo 18 e menor ou igual a age_max.';
COMMENT ON COLUMN test_audience_criteria.estimated_reach IS 'Calculado no servidor. Precisa ser maior que zero para publicar (Tela 09 RN-01).';

CREATE TABLE test_form_questions (
  id        uuid PRIMARY KEY,
  test_id   uuid NOT NULL REFERENCES tests (id) ON DELETE CASCADE,
  type      question_type NOT NULL,
  label     text NOT NULL,
  help_text text,
  required  boolean NOT NULL DEFAULT false,
  position  integer NOT NULL,
  scale_min integer,
  scale_max integer
);
COMMENT ON COLUMN test_form_questions.required IS 'Bloqueia o envio do formulario pelo jogador enquanto nao respondida.';
COMMENT ON COLUMN test_form_questions.position IS 'Ordem persistida EXATAMENTE como definida. O PUT do formulario substitui o conjunto inteiro numa transacao, o que torna a reordenacao atomica.';
CREATE UNIQUE INDEX test_form_questions_order_unique ON test_form_questions (test_id, position);

CREATE TABLE test_form_options (
  id          uuid PRIMARY KEY,
  question_id uuid NOT NULL REFERENCES test_form_questions (id) ON DELETE CASCADE,
  label       text NOT NULL,
  position    integer NOT NULL
);
COMMENT ON TABLE test_form_options IS '[novo] Tipos com opcoes exigem a quantidade minima do componente.';
CREATE UNIQUE INDEX test_form_options_order_unique ON test_form_options (question_id, position);

CREATE TABLE builds (
  id              uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  test_id         uuid NOT NULL REFERENCES tests (id) ON DELETE CASCADE,
  file_name       text NOT NULL,
  version         text,
  platform        text,
  size_bytes      bigint,
  checksum        text,
  storage_key     text NOT NULL,
  status          build_status NOT NULL DEFAULT 'awaiting_upload',
  failure_reason  text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE  builds IS '[novo] Upload direto ao storage via presigned PUT. O servidor nunca faz proxy dos bytes.';
COMMENT ON COLUMN builds.version IS 'Comparada com a versao local do jogador para decidir se precisa baixar de novo.';

CREATE TABLE build_validation_steps (
  id          uuid PRIMARY KEY,
  build_id    uuid NOT NULL REFERENCES builds (id) ON DELETE CASCADE,
  key         build_step_key NOT NULL,
  status      processing_status NOT NULL DEFAULT 'processing',
  message     text,
  finished_at timestamptz
);
COMMENT ON TABLE  build_validation_steps IS '[novo] A validacao e uma LISTA DE ETAPAS, nao um booleano: permite o passo plugin_manifest entrar depois sem reescrever o fluxo, e deixa a UI mostrar ONDE falhou.';
COMMENT ON COLUMN build_validation_steps.key IS 'plugin_manifest ja esta no enum de proposito, mesmo com o plug-in fora de escopo.';
CREATE UNIQUE INDEX build_validation_steps_unique ON build_validation_steps (build_id, key);


-- =============================================================================
-- PARTICIPACAO E SESSAO
-- =============================================================================

CREATE TABLE participations (
  id              uuid PRIMARY KEY,
  test_id         uuid NOT NULL REFERENCES tests (id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status          participation_status NOT NULL DEFAULT 'reserved',
  resume_point    text,
  idempotency_key text,
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE  participations IS '[novo] Precisa de UNIQUE PARCIAL em (test_id, user_id) enquanto o status for ativo. E isso que impede duas participacoes simultaneas no mesmo teste (Tela 14 RN-02). Regra de corrida nao se resolve em codigo de servico.';
COMMENT ON COLUMN participations.resume_point IS 'Ponto de retomada permitido pelo modelo do teste.';
CREATE INDEX participations_test_user_idx ON participations (test_id, user_id);

CREATE TABLE session_consents (
  participation_id uuid PRIMARY KEY REFERENCES participations (id) ON DELETE CASCADE,
  screen_recording boolean NOT NULL DEFAULT false,
  audio            boolean NOT NULL DEFAULT false,
  microphone       boolean NOT NULL DEFAULT false,
  webcam           boolean NOT NULL DEFAULT false,
  accepted_at      timestamptz,
  ip               text,
  user_agent       text
);
COMMENT ON TABLE session_consents IS '[novo] Registrado ANTES da sessao quando obrigatorio. E prova: append-only, sem update.';

CREATE TABLE sessions (
  id                      uuid PRIMARY KEY,
  participation_id        uuid NOT NULL REFERENCES participations (id) ON DELETE CASCADE,
  test_id                 uuid NOT NULL REFERENCES tests (id) ON DELETE CASCADE,
  organization_id         uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  status                  session_status NOT NULL DEFAULT 'starting',
  started_at              timestamptz NOT NULL DEFAULT now(),
  ended_at                timestamptz,
  duration_ms             integer,
  finish_idempotency_key  text
);
COMMENT ON COLUMN sessions.organization_id IS 'Tenancy desce ate aqui: a sessao exibida pertence ao teste selecionado E a organizacao logada.';
CREATE INDEX sessions_test_idx ON sessions (test_id);

CREATE TABLE session_device_events (
  id         uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  t_ms       integer NOT NULL,
  kind       text NOT NULL,
  value      boolean NOT NULL
);
COMMENT ON COLUMN session_device_events.t_ms IS 'BASE TEMPORAL UNICA da sessao, em ms desde o inicio. Video, transcricao, telemetria e insights se ancoram nela. Precisa estar certa agora, nao depois.';
CREATE INDEX session_device_events_idx ON session_device_events (session_id, t_ms);

CREATE TABLE session_recordings (
  id            uuid PRIMARY KEY,
  session_id    uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  kind          recording_kind NOT NULL,
  storage_key   text NOT NULL,
  content_type  text,
  size_bytes    bigint,
  duration_ms   integer,
  status        processing_status NOT NULL DEFAULT 'processing',
  thumbnail_key text
);
COMMENT ON COLUMN session_recordings.status IS 'Gravacao ausente NAO bloqueia o resto dos dados da sessao (Tela 12 RN-03).';

CREATE TABLE session_validations (
  session_id        uuid PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
  valid             boolean,
  reason            text,
  validator_version text,
  validated_at      timestamptz
);
COMMENT ON TABLE session_validations IS '[novo] O GATILHO de XP, conquista e recompensa. Tabela propria e nao um campo em sessions porque a transicao precisa ser um insert unico e transacional (Tela 19 RN-03).';

CREATE TABLE form_responses (
  id              uuid PRIMARY KEY,
  session_id      uuid NOT NULL UNIQUE REFERENCES sessions (id) ON DELETE CASCADE,
  idempotency_key text,
  submitted_at    timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN form_responses.session_id IS 'UNIQUE. E o que garante que reenviar o formulario nao gera uma segunda avaliacao (Tela 18 RN-03).';

CREATE TABLE form_answers (
  id            uuid PRIMARY KEY,
  response_id   uuid NOT NULL REFERENCES form_responses (id) ON DELETE CASCADE,
  question_id   uuid NOT NULL REFERENCES test_form_questions (id),
  value_text    text,
  value_number  numeric,
  value_boolean boolean,
  option_ids    uuid[]
);


-- =============================================================================
-- FEED E GAMIFICACAO
-- =============================================================================

CREATE TABLE player_preferences (
  user_id        uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  genres         text[],
  platforms      text[],
  device_profile jsonb,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE player_preferences IS '[novo] Sinais do ranking organico do feed. Pesos ainda a definir (pendencia BACKEND-SPEC 9).';

CREATE TABLE feed_ranking_snapshots (
  seed         text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  filters_hash text,
  item_ids     uuid[] NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
COMMENT ON TABLE  feed_ranking_snapshots IS '[novo] O cursor padrao da API (UUIDv7) assume ordem cronologica estavel. Um feed rankeado muda entre requisicoes: paginar sem congelar a ordem produz item repetido e item pulado. Como e efemero, Redis e alternativa aceitavel.';
COMMENT ON COLUMN feed_ranking_snapshots.item_ids IS 'Ordem congelada da sessao de navegacao.';

CREATE TABLE xp_events (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source_type text NOT NULL,
  source_id   uuid NOT NULL,
  xp          integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE xp_events IS '[novo] Ledger append-only. XP total e nivel sao DERIVADOS da soma, nunca um contador editavel. A unique composta e o que faz recarregar nao duplicar XP (Tela 19 RN-03).';
CREATE UNIQUE INDEX xp_events_source_unique ON xp_events (user_id, source_type, source_id);

CREATE TABLE achievements (
  key         text PRIMARY KEY,
  name        text NOT NULL,
  description text,
  icon_key    text,
  rule        jsonb
);
COMMENT ON TABLE achievements IS '[novo] Catalogo. Criterios de desbloqueio ainda a definir (pendencia BACKEND-SPEC 9).';

CREATE TABLE player_achievements (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  achievement_key text NOT NULL REFERENCES achievements (key),
  progress        numeric NOT NULL DEFAULT 0,
  unlocked_at     timestamptz
);
CREATE UNIQUE INDEX player_achievements_unique ON player_achievements (user_id, achievement_key);

CREATE TABLE missions (
  key         text PRIMARY KEY,
  name        text NOT NULL,
  description text,
  reward_xp   integer,
  expires_at  timestamptz
);

CREATE TABLE player_missions (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  mission_key  text NOT NULL REFERENCES missions (key),
  progress     numeric NOT NULL DEFAULT 0,
  completed_at timestamptz
);
CREATE UNIQUE INDEX player_missions_unique ON player_missions (user_id, mission_key);

CREATE TABLE ranking_snapshots (
  id          uuid PRIMARY KEY,
  scope       text NOT NULL,
  period      text NOT NULL,
  game_id     uuid REFERENCES games (id) ON DELETE CASCADE,
  entries     jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE ranking_snapshots IS '[novo] Materializado por job. Ranking calculado a cada request nao escala. Escopo e periodicidade a definir.';


-- =============================================================================
-- RELATORIOS, COMUNIDADE E INFRA
-- =============================================================================

CREATE TABLE test_report_snapshots (
  id          uuid PRIMARY KEY,
  test_id     uuid NOT NULL REFERENCES tests (id) ON DELETE CASCADE,
  block_key   text NOT NULL,
  status      processing_status NOT NULL DEFAULT 'processing',
  payload     jsonb,
  computed_at timestamptz
);
COMMENT ON TABLE  test_report_snapshots IS '[novo] UM REGISTRO POR BLOCO, nao um payload por teste. E o que permite telemetria e IA entrarem depois como blocos novos, e o que faz um bloco em erro nao derrubar o relatorio inteiro.';
COMMENT ON COLUMN test_report_snapshots.payload IS 'Metricas refletem SOMENTE sessoes validas do teste (Tela 11 RN-01).';
CREATE UNIQUE INDEX test_report_snapshots_unique ON test_report_snapshots (test_id, block_key);

CREATE TABLE game_reviews (
  id         uuid PRIMARY KEY,
  game_id    uuid NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  rating     numeric NOT NULL,
  body       text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX game_reviews_unique ON game_reviews (game_id, user_id);

CREATE TABLE community_posts (
  id             uuid PRIMARY KEY,
  game_id        uuid NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  body           text NOT NULL,
  status         post_status NOT NULL DEFAULT 'visible',
  moderated_by   uuid REFERENCES users (id),
  moderated_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE community_reports (
  id                uuid PRIMARY KEY,
  post_id           uuid NOT NULL REFERENCES community_posts (id) ON DELETE CASCADE,
  reporter_user_id  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  reason            text NOT NULL,
  detail            text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind       text NOT NULL,
  title      text NOT NULL,
  body       text,
  link       text,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_keys (
  key             text PRIMARY KEY,
  user_id         uuid REFERENCES users (id) ON DELETE CASCADE,
  endpoint        text NOT NULL,
  request_hash    text,
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL
);
COMMENT ON TABLE idempotency_keys IS '[novo] Guarda a resposta original para reproduzi-la em repeticao. Redis cobre o caso comum; a tabela e o registro duravel. A protecao REAL contra corrida sao as unique constraints nas tabelas de recurso.';


-- =============================================================================
-- CONGELADAS — PLUG-IN E TELEMETRIA (dormentes, contrato imutavel)
-- Apague este bloco no dbdiagram se quiser ver so o escopo ativo.
-- =============================================================================

CREATE TABLE plugin_manifests (
  id           uuid PRIMARY KEY,
  build_id     uuid REFERENCES builds (id),
  sdk_version  text NOT NULL,
  engine       text NOT NULL,
  raw_manifest jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN plugin_manifests.build_id IS 'ATENCAO: hoje e uuid SEM FK, porque a tabela builds nao existe (DECISIONS.md 1.3). A FK mostrada aqui e a divida a quitar na migracao que criar builds.';

CREATE TABLE trigger_definitions (
  id          uuid PRIMARY KEY,
  manifest_id uuid NOT NULL REFERENCES plugin_manifests (id) ON DELETE CASCADE,
  key         text NOT NULL,
  label       text NOT NULL,
  type        trigger_type NOT NULL,
  unit        text,
  config      jsonb
);
COMMENT ON COLUMN trigger_definitions.type IS 'Tipos CONGELADOS. Builds publicadas e o SDK dependem destes valores.';

CREATE TABLE session_tokens (
  id         uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE session_tokens IS '[congelada] Autentica o plug-in, nao e o JWT do usuario.';

CREATE TABLE telemetry_events (
  id           uuid PRIMARY KEY,
  session_id   uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  trigger_key  text NOT NULL,
  type         trigger_type NOT NULL,
  value_num    numeric,
  value_json   jsonb,
  t_ms         integer,
  event_id     text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE  telemetry_events IS '[congelada] Particionada por dia (PARTITION BY RANGE (received_at)) — o Drizzle nao expressa isso, entao vive em drizzle/manual/. O particionamento nao esta representado neste SQL de diagrama.';
COMMENT ON COLUMN telemetry_events.event_id IS 'Upsert por (session_id, event_id): reenvio nao infla metrica.';
CREATE UNIQUE INDEX telemetry_events_dedup ON telemetry_events (session_id, event_id);

CREATE TABLE heatmap_cells (
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  x          integer NOT NULL,
  y          integer NOT NULL,
  z          integer NOT NULL,
  count      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, x, y, z)
);
COMMENT ON TABLE heatmap_cells IS '[congelada] PK composta para o upsert incrementar count.';
