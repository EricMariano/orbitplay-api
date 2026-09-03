# OrbitPlay API — o que já existe e o que falta

> Gerado em 2026-09-01. Fonte cruzada entre:
>
> - **Alvo (design):** `docs/openapi.design.yaml` (contrato, v0.2.0-design) e `docs/schema.dbdiagram.sql` (modelo de dados).
> - **Realidade (implementado):** controllers em `src/modules/*`, schema Drizzle em `src/infra/database/schema/`, migração `drizzle/0000_safe_bishop.sql` e a manual `drizzle/manual/0001_telemetry_events_partitioned.sql`, além do `openapi.json` gerado.
>
> Regra de leitura: o `openapi.design.yaml` é o **alvo** e nunca é gerado. O `openapi.json` da raiz é **gerado do Nest** e descreve só o que roda. O `schema.dbdiagram.sql` é só para diagramar — **não** é a fonte da verdade do banco (essa é o TypeScript do Drizzle).

---

## 1. Resumo executivo

O que está de pé hoje é a **fundação da plataforma**: autenticação/sessão, tenancy por organização, CRUD de jogos e leitura de organização/membros. Isso corresponde grosso modo aos módulos **M1 (auth), M2 (orgs) e M3 (games)** — e mesmo esses ainda têm pontas soltas marcadas como `partial`.

Todo o **núcleo do domínio** (testes, builds, participações, sessões, gravação, relatórios, feed do jogador, gamificação, comunidade, notificações) está **apenas desenhado** — existe contrato OpenAPI e modelo de dados, mas **nenhuma tabela migrada nem endpoint implementado**.

| Camada            | Situação                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------- |
| Endpoints HTTP    | **~14 implementados/parciais** de **~90 desenhados** (≈ 15%)                             |
| Tabelas no banco  | **12 migradas** de **~40 desenhadas** (+ `telemetry_events` particionada manual)         |
| Enums             | **3 criados** (`game_status`, `membership_status`, `trigger_type`) de **~16 desenhados** |
| Módulos completos | Nenhum 100%; M1/M2/M3 parcialmente prontos, M4–M15 pendentes                             |

---

## 2. Endpoints — implementado vs. faltando

Legenda: ✅ implementado · 🟡 parcial (existe mas incompleto) · ⬜ a fazer (só no design)

### M1 — Auth (`src/modules/auth`)

| Endpoint                        | Status | Observação                                                    |
| ------------------------------- | ------ | ------------------------------------------------------------- |
| `POST /auth/login`              | ✅     |                                                               |
| `POST /auth/refresh`            | ✅     | rotação com detecção de reuso                                 |
| `POST /auth/logout`             | ✅     |                                                               |
| `GET /auth/me`                  | ✅     |                                                               |
| `POST /auth/password/forgot`    | ✅     | token de uso único + e-mail; resposta sempre genérica (RN-05) |
| `POST /auth/password/reset`     | ✅     | consome token; revoga sessões ativas                          |
| `POST /auth/signup/studio`      | ✅     | cria user+org+membership owner em transação; já loga          |
| `POST /auth/signup/player`      | ✅     | cria user+org pessoal+membership player; 18+; já loga         |
| `GET /auth/signup/availability` | ✅     | `{ available }` + throttle agressivo (IP + e-mail)            |

### M2 — Orgs (`src/modules/orgs` + `src/modules/audit`)

| Endpoint                                     | Status | Observação                                        |
| -------------------------------------------- | ------ | ------------------------------------------------- |
| `GET /orgs/current`                          | ✅     |                                                   |
| `GET /orgs/members`                          | 🟡     | sem paginação nem filtros (`q`, `role`, `status`) |
| `PATCH /orgs/current`                        | ⬜     |                                                   |
| `POST /orgs/members/invite`                  | ⬜     |                                                   |
| `PATCH /orgs/members/{userId}/role`          | ⬜     | regra do "último owner" (409), auditoria          |
| `PATCH /orgs/members/{userId}/status`        | ⬜     |                                                   |
| `POST /orgs/members/{userId}/password-reset` | ⬜     |                                                   |
| `DELETE /orgs/members/{userId}`              | ⬜     |                                                   |
| `GET /audit-logs`                            | ⬜     | tabela existe, **falta expor**                    |

### M3 — Games (`src/modules/games`)

| Endpoint                              | Status | Observação                                               |
| ------------------------------------- | ------ | -------------------------------------------------------- |
| `POST /games`                         | ✅     | tenancy forçada (org do token)                           |
| `GET /games/{id}`                     | ✅     |                                                          |
| `PATCH /games/{id}`                   | ✅     |                                                          |
| `DELETE /games/{id}`                  | ✅     | exclusão lógica                                          |
| `GET /games`                          | 🟡     | sem filtros e **sem métricas agregadas** (`GameMetrics`) |
| `POST /games/{id}/assets/upload-url`  | ⬜     | tabela `game_assets` existe mas sem uso                  |
| `POST /games/{id}/assets`             | ⬜     | confirmação de upload                                    |
| `DELETE /games/{id}/assets/{assetId}` | ⬜     |                                                          |
| `GET /games/{id}/summary`             | ⬜     |                                                          |
| `GET /games/{id}/tests`               | ⬜     |                                                          |
| `GET /games/{id}/achievements`        | ⬜     |                                                          |
| `GET /games/{id}/specs`               | ⬜     |                                                          |

### M15 — Health (`src/modules/health`)

| Endpoint            | Status | Observação                        |
| ------------------- | ------ | --------------------------------- |
| `GET /health`       | ✅     | checa Postgres, Redis, storage    |
| `GET /health/ready` | ⬜     | readiness incluindo fila (BullMQ) |

### M4–M14 — **totalmente a fazer** (só no design)

Nenhum endpoint destes módulos está implementado:

- **M4 test-models:** `GET /test-models`, `GET /test-models/{key}`
- **M5 tests (wizard):** `POST /games/{gameId}/tests`, `GET /tests/{id}`, `PATCH /tests/{id}/model`, `PUT /tests/{id}/form`, `GET /tests/{id}/form/preview`, `POST /tests/{id}/build/upload-url`, `POST|GET|DELETE /tests/{id}/build`, `PATCH /tests/{id}/audience`, `POST /tests/{id}/publish`, `PATCH /tests/{id}/status`
- **M6 builds:** `GET /builds/{id}`, `GET /builds/{id}/compatibility`, `GET /builds/{id}/download-url`
- **M7 player-feed:** `GET /player/home`, `GET /player/feed`, `GET /player/feed/filters`, `GET /player/games/{gameId}`, `GET /player/games/{gameId}/tests`, `GET /player/tests/{testId}`, `GET /player/participations`
- **M8 participations/sessions:** `POST /player/tests/{testId}/participations`, `GET /participations/{id}`, `POST /participations/{id}/consents`, `GET /participations/{id}/tutorial`, `POST /participations/{id}/sessions`, `PATCH /sessions/{id}/devices`, `POST /sessions/{id}/heartbeat`, `POST /sessions/{id}/finish`, `GET /sessions/{id}/summary`, `POST /sessions/{id}/form-response`, `GET /participations/{id}/result`
- **M9 media:** `POST /sessions/{id}/recordings/upload-url`, `POST /sessions/{id}/recordings/complete`, `GET /sessions/{id}/recordings/{recordingId}/playback-url`
- **M10 reports:** `GET /tests/{id}/report`, `.../report/evolution`, `.../report/ratings`, `.../report/testers`, `GET /tests/{id}/sessions`, `GET /sessions/{id}`, `POST /sessions/{id}/rate`, `GET /tests/{id}/report/export`
- **M11 dashboard:** `GET /studio/dashboard`, `GET /studio/benchmark`
- **M12 gamification:** `GET /player/progress`, `GET /player/achievements`, `GET /player/missions`, `GET /rankings`
- **M13 community:** `GET|POST /games/{gameId}/community/posts`, `POST /community/posts/{id}/report`, `PATCH /community/posts/{id}/moderate`, `GET|POST /games/{gameId}/reviews`
- **M14 notifications:** `GET /notifications`, `PATCH /notifications/{id}/read`

---

## 3. Banco de dados — tabelas

### ✅ Já migradas (`drizzle/0000` + `0001` + schema Drizzle)

`users`, `organizations`, `roles`, `memberships`, `refresh_tokens`, `password_reset_tokens`, `games`, `game_assets`, `audit_log` — mais as tabelas **congeladas/dormentes** do plug-in/telemetria: `plugin_manifests`, `trigger_definitions`, `session_tokens`, `heatmap_cells`, e `telemetry_events` (particionada por dia, migração **manual** em `drizzle/manual/`).

Enums criados: `game_status`, `membership_status`, `trigger_type`.

Ressalvas sobre o que existe mas não é usado de ponta a ponta:

- **`game_assets`** — tabela criada, **nenhum código a consome** (upload de capa/banner da Tela 04 é trabalho novo inteiro).
- **`audit_log`** — existe e é escrita, mas **não há endpoint** que a exponha (`GET /audit-logs` é ⬜).
- **`plugin_manifests.build_id`** — hoje é `uuid` **sem FK**, porque `builds` ainda não existe (dívida a quitar quando `builds` for criada).

### ⬜ A criar (estão no `schema.dbdiagram.sql`, faltam no banco)

**Jogo/teste/build:** `tests`, `test_audience_criteria`, `test_form_questions`, `test_form_options`, `builds`, `build_validation_steps`
**Participação/sessão:** `participations`, `session_consents`, `sessions`, `session_device_events`, `session_recordings`, `session_validations`, `form_responses`, `form_answers`
**Feed/gamificação:** `player_preferences`, `feed_ranking_snapshots`, `xp_events`, `achievements`, `player_achievements`, `missions`, `player_missions`, `ranking_snapshots`
**Relatórios/comunidade/infra:** `test_report_snapshots`, `game_reviews`, `community_posts`, `community_reports`, `notifications`, `idempotency_keys`

Enums a criar: `test_status`, `wizard_step`, `test_model_key`, `question_type`, `build_status`, `build_step_key`, `processing_status`, `participation_status`, `session_status`, `recording_kind`, `asset_kind`, `post_status`, `report_stage`.

---

## 4. Pontos de atenção do design (invariantes que a implementação precisa respeitar)

Estes já estão documentados no contrato e no SQL; valem como requisitos ao implementar cada peça:

1. **`tests.slots_taken` é contador concorrente** — usar `UPDATE ... WHERE slots_taken < slots_total` checando linhas afetadas; nunca `SELECT` seguido de `UPDATE`.
2. **`participations` precisa de UNIQUE parcial** em `(test_id, user_id)` enquanto o status for ativo — é o que impede duas participações simultâneas (Tela 14 RN-02).
3. **Idempotência real vem de UNIQUE nas tabelas de recurso** (`tests.publish_idempotency_key`, `form_responses.session_id`, `xp_events (user_id, source_type, source_id)`), não só da tabela `idempotency_keys`/Redis.
4. **Validação da sessão é o gatilho transacional** de XP/conquista/recompensa (`session_validations` como insert único) — recarregar não pode duplicar XP.
5. **Relatório em blocos independentes** (`test_report_snapshots`, um registro por bloco) — um bloco em erro não derruba a página; telemetria/IA entram como blocos novos.
6. **Feed usa ranking congelado** (`feed_ranking_snapshots`), exceção à paginação por cursor UUIDv7 padrão da API.
7. **`tMs` é a base temporal única da sessão** — vídeo, eventos de dispositivo, telemetria e insights se ancoram nela.
8. **Uploads sempre por URL assinada** — a API nunca faz proxy de binário.

---

## 5. Fora de escopo desta fase (deferido — BACKEND-SPEC §10)

Não estão nem no contrato ativo nem para implementar agora: cobrança do estúdio, carteira/saque do jogador, impulsionamento (boost) do feed, Orbit Plug-in + ingestão de telemetria, insights de IA e transcrição (ASR). As tabelas de plug-in/telemetria existem **congeladas** só para manter o contrato estável quando voltarem.

---

## 6. Sugestão de ordem de ataque

Seguindo as dependências do domínio (cada linha destrava a próxima):

1. **Fechar M1/M2/M3** (pontas `partial`): paginação/filtros e métricas em `GET /orgs/members` e `GET /games`; signup studio/player; expor `GET /audit-logs`; assets de jogo.
2. **M4 test-models** (catálogo, sem dependência pesada).
3. **M5 tests + M6 builds** (núcleo do estúdio): tabelas `tests`, `test_*`, `builds`, `build_validation_steps` e o wizard.
4. **M7/M8** (jogador): feed, participações, sessões, consentimentos.
5. **M9 media** e **M10 reports** (dependem de sessões existirem).
6. **M11 dashboard, M12 gamificação, M13 comunidade, M14 notificações.**
7. **M15** `/health/ready`.
