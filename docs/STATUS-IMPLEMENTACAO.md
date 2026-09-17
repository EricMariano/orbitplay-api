# OrbitPlay API — o que já existe e o que falta

> Atualizado em 2026-09-16 (revisão anterior: 2026-09-01). Fonte cruzada entre:
>
> - **Alvo (design):** `docs/openapi.design.yaml` (contrato, v0.2.0-design) e `docs/schema.dbdiagram.sql` (modelo de dados).
> - **Realidade (implementado):** controllers em `src/modules/*`, schema Drizzle em `src/infra/database/schema/`, migrações `drizzle/0000` a `drizzle/0003` e a manual `drizzle/manual/0001_telemetry_events_partitioned.sql`, além do `openapi.json` gerado.
>
> Regra de leitura: o `openapi.design.yaml` é o **alvo** e nunca é gerado. O `openapi.json` da raiz é **gerado do Nest** e descreve só o que roda. O `schema.dbdiagram.sql` é só para diagramar — **não** é a fonte da verdade do banco (essa é o TypeScript do Drizzle).

---

## 1. Resumo executivo

O que está de pé hoje é a **fundação da plataforma** mais o fluxo de mídia e o núcleo do estúdio: autenticação/sessão, tenancy por organização, CRUD de jogos, gestão completa de organização/membros, auditoria, catálogo de modelos de teste, upload/playback de gravação e o **wizard de criação de teste completo**. Isso corresponde aos módulos **M1 (auth), M2 (orgs), M4 (test-models), M5 (tests/wizard), M9 (media) e M15 (health)** — todos fechados — e ao **M3 (games)**, que tem só uma ponta solta (`/games/{id}/achievements`), **bloqueada** pelo M12 (gamificação), que ainda não existe. A outra ponta de M3 (`/games/{id}/tests`) já não está bloqueada — o M5 existe — só falta implementá-la.

O **restante do núcleo do domínio** (builds — validação além do que o M5 já cobre —, participações, sessões, relatórios, feed do jogador, gamificação, comunidade, notificações) continua sem nenhum endpoint implementado — mas **já não está bloqueado pelo banco**.

> **Mudança desde a revisão anterior:** a migração `0002_flowery_thunderbolt.sql` criou **28 tabelas e 13 enums de uma vez**. Hoje as **41 tabelas e os 16 enums do design estão todos migrados**, com os índices/UNIQUEs dos invariantes já no lugar. Na prática, os cards de schema dos épicos pendentes (M6-01, M7-01, M8-01, M10-01, M12-01, M13-01, M14-01) **estão feitos**: o que falta nesses módulos é exclusivamente a camada de aplicação (controller/service/repository/DTO). O M5 (wizard) fechou nesta revisão, junto com um worker novo (`build.validate`) que roda sobre `builds`/`build_validation_steps` — a parte de compatibilidade/download desse par de tabelas (M6) segue em aberto.

| Camada            | Situação                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------- |
| Endpoints HTTP    | **47 operações implementadas** de **92 desenhadas** (≈ 51%) — 40 de 84 caminhos           |
| Tabelas no banco  | **41 migradas** de **41 desenhadas** (+ `telemetry_events` particionada, migração manual) |
| Enums             | **16 criados** de **16 desenhados**                                                       |
| Módulos completos | M1, M2, M4, M5, M9, M15 prontos; M3 parcial (bloqueado só por M12); M6–M8 e M10–M14 pendentes |

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

| Endpoint                                     | Status | Observação                                                                                              |
| -------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------- |
| `GET /orgs/current`                          | ✅     |                                                                                                         |
| `GET /orgs/members`                          | ✅     | paginação por cursor + filtros `q`/`role`/`status`                                                      |
| `PATCH /orgs/current`                        | ✅     | atualiza `name`/`slug`; owner/admin; 409 no slug duplicado                                              |
| `POST /orgs/members/invite`                  | ✅     | membership `invited` + e-mail; owner/admin                                                              |
| `PATCH /orgs/members/{userId}/role`          | ✅     | owner-only; `confirm:true`; último owner → 409                                                          |
| `PATCH /orgs/members/{userId}/status`        | ✅     | owner/admin; `confirm:true`; nunca a si mesmo; último owner ativo → 409                                 |
| `POST /orgs/members/{userId}/password-reset` | ✅     | owner/admin; dispara e-mail, nunca expõe a senha                                                        |
| `DELETE /orgs/members/{userId}`              | ✅     | owner/admin (não owner-only — ver nota); nunca a si mesmo; desativação lógica; último owner ativo → 409 |
| `GET /audit-logs`                            | ✅     | paginação por cursor + filtros actor/action/from/to                                                     |

> **Nota (desvio do design):** `DELETE /orgs/members/{userId}` está como `owner`/`admin`, não "owner" puro como a tabela do `BACKEND-SPEC.md` §3 lista. Combinado com a auto-proteção (ninguém altera/remove a própria membership), "owner-only" tornaria a regra do último owner ativo (RN-03) **inalcançável** nesse endpoint — um owner nunca pode ser ao mesmo tempo quem chama e o único owner restante. Permitir admin mantém a regra testável de fato.

### M3 — Games (`src/modules/games`)

| Endpoint                              | Status | Observação                                                    |
| ------------------------------------- | ------ | ------------------------------------------------------------- |
| `POST /games`                         | ✅     | tenancy forçada (org do token)                                |
| `GET /games/{id}`                     | ✅     |                                                               |
| `PATCH /games/{id}`                   | ✅     |                                                               |
| `DELETE /games/{id}`                  | ✅     | exclusão lógica                                               |
| `GET /games`                          | ✅     | filtros `q`/`status`, paginação e `GameMetrics`               |
| `POST /games/{id}/assets/upload-url`  | ✅     | URL assinada (PNG/JPEG/WebP, até 5 MiB)                       |
| `POST /games/{id}/assets`             | ✅     | confirma objeto no storage antes de gravar                    |
| `DELETE /games/{id}/assets/{assetId}` | ✅     | exclusão lógica + remove o objeto                             |
| `GET /games/{id}/summary`             | ✅     | banner, disponibilidade, `canEdit`, métricas                  |
| `GET /games/{id}/tests`               | ⬜     | não bloqueado — M5 já existe, falta só implementar este endpoint |
| `GET /games/{id}/achievements`        | ⬜     | bloqueado — depende dos endpoints do M12 (tabelas já existem) |
| `GET /games/{id}/specs`               | ✅     | stub vazio — campos da Tela 04 ainda indefinidos (§9 #1)      |

### M4 — Catálogo de modelos de teste (`src/modules/test-models`)

| Endpoint                | Status | Observação                                                                   |
| ------------------------ | ------ | ----------------------------------------------------------------------------- |
| `GET /test-models`       | ✅     | catálogo estático (4 modelos), `studio+`                                     |
| `GET /test-models/{key}` | ✅     | `key` inválida → 404; `free_exploration_telemetry` vem `available:false`      |

> **Nota:** catálogo é uma constante no código (`test-models.catalog.ts`), não uma tabela — casa com "requisitos técnicos vêm da configuração do backend" (RN-03). `name`/`description`/`deliverables`/`technicalRequirements` são copy **placeholder** até o handoff de produto/Figma; ver `DECISIONS.md` §3.

### M5 — Wizard de criação de teste (`src/modules/tests`)

| Endpoint                          | Status | Observação                                                                      |
| ---------------------------------- | ------ | -------------------------------------------------------------------------------- |
| `POST /games/{gameId}/tests`       | ✅     | nasce `draft`, já com `modelKey` (Tela 06); currentStep parte de `form`          |
| `GET /tests/{id}`                  | ✅     | `currentStep` (1-5) e `pendingValidations` decididos no backend                  |
| `PATCH /tests/{id}/model`          | ✅     | modelo indisponível → 422; só em `draft`                                        |
| `PUT /tests/{id}/form`             | ✅     | substitui o conjunto inteiro em 1 transação; `position` é autoridade             |
| `GET /tests/{id}/form/preview`     | ✅     |                                                                                   |
| `POST /tests/{id}/build/upload-url`| ✅     | URL assinada única (sem multipart); até 5 GiB                                    |
| `POST /tests/{id}/build`           | ✅     | confirma upload, enfileira `build.validate`, devolve `202 processing`            |
| `GET /tests/{id}/build`            | ✅     | `validationSteps[]`; `failureReason` quando falha                                |
| `DELETE /tests/{id}/build`         | ✅     | teste publicado → 409; senão remove build + objeto do storage                    |
| `PATCH /tests/{id}/audience`       | ✅     | `estimatedReach` calculado de verdade (jogadores elegíveis por idade)            |
| `POST /tests/{id}/publish`         | ✅     | `Idempotency-Key` obrigatório (422 se ausente); `422` com `pendingValidations` se incompleto |
| `PATCH /tests/{id}/status`         | ✅     | transições `published⇄paused`, `→finished`; inválida → 409                       |

> **Notas:** enums (`TestStatus`, `QuestionType`, `Build.status`, `ValidationStep`) seguem o schema Drizzle migrado, não `openapi.design.yaml` (que ficou desatualizado nesses nomes) — ver `DECISIONS.md` §3. O worker `build.validate` (`src/workers/build.processor.ts`) roda 3 etapas (`checksum`, `malware_scan`, `metadata`) sem integração real de antivírus — mesmo padrão de stub documentado do `media.transcode` (M9); `plugin_manifest` fica reservado, sem etapa instanciada (ORB-M6-02). Uma build por teste é regra de aplicação (troca automática se a anterior falhou; senão exige `DELETE` explícito).

### M15 — Health (`src/modules/health`)

| Endpoint            | Status | Observação                     |
| ------------------- | ------ | ------------------------------ |
| `GET /health`       | ✅     | checa Postgres, Redis, storage |
| `GET /health/ready` | ✅     | idem + fila (BullMQ)           |

### M9 — Media (`src/modules/media`)

| Endpoint                                                   | Status | Observação                                                                 |
| ---------------------------------------------------------- | ------ | -------------------------------------------------------------------------- |
| `POST /sessions/{id}/recordings/upload-url`                | ✅     | multipart; papel `player`; URL assinada (sem proxy de binário)             |
| `POST /sessions/{id}/recordings/complete`                  | ✅     | confirma objeto, `status: processing`, enfileira transcode + extract-audio |
| `GET /sessions/{id}/recordings/{recordingId}/playback-url` | ✅     | `url: null` enquanto `processing`/`failed`/`unavailable` (Tela 12 RN-03)   |

### M6–M14 — **a fazer** (só no design, exceto M4, M5 e M9)

Nenhum endpoint destes módulos está implementado (M4, M5 e M9 acima já saíram desta lista). **As tabelas de todos eles já existem no banco** — falta só a camada HTTP. São **45 operações** em 43 caminhos, mais as 2 pontas soltas do M3:

| Módulo             | Operações faltando |
| ------------------ | ------------------ |
| M3 (pontas soltas) | 2                  |
| M6 builds          | 3                  |
| M7 player-feed     | 7                  |
| M8 participações   | 11                 |
| M10 reports        | 8                  |
| M11 dashboard      | 2                  |
| M12 gamificação    | 4                  |
| M13 comunidade     | 6                  |
| M14 notificações   | 2                  |
| **Total**          | **45**             |

- **M6 builds:** `GET /builds/{id}`, `GET /builds/{id}/compatibility`, `GET /builds/{id}/download-url`
- **M7 player-feed:** `GET /player/home`, `GET /player/feed`, `GET /player/feed/filters`, `GET /player/games/{gameId}`, `GET /player/games/{gameId}/tests`, `GET /player/tests/{testId}`, `GET /player/participations`
- **M8 participations/sessions:** `POST /player/tests/{testId}/participations`, `GET /participations/{id}`, `POST /participations/{id}/consents`, `GET /participations/{id}/tutorial`, `POST /participations/{id}/sessions`, `PATCH /sessions/{id}/devices`, `POST /sessions/{id}/heartbeat`, `POST /sessions/{id}/finish`, `GET /sessions/{id}/summary`, `POST /sessions/{id}/form-response`, `GET /participations/{id}/result`
- **M10 reports:** `GET /tests/{id}/report`, `.../report/evolution`, `.../report/ratings`, `.../report/testers`, `GET /tests/{id}/sessions`, `GET /sessions/{id}`, `POST /sessions/{id}/rate`, `GET /tests/{id}/report/export`
- **M11 dashboard:** `GET /studio/dashboard`, `GET /studio/benchmark`
- **M12 gamification:** `GET /player/progress`, `GET /player/achievements`, `GET /player/missions`, `GET /rankings`
- **M13 community:** `GET|POST /games/{gameId}/community/posts`, `POST /community/posts/{id}/report`, `PATCH /community/posts/{id}/moderate`, `GET|POST /games/{gameId}/reviews`
- **M14 notifications:** `GET /notifications`, `PATCH /notifications/{id}/read`

---

## 3. Banco de dados — tabelas

### ✅ Já migradas — **todas as 41 tabelas do design**

`drizzle/0000` trouxe as 12 da fundação (`users`, `organizations`, `roles`, `memberships`, `refresh_tokens`, `games`, `game_assets`, `audit_log` + as congeladas de plug-in/telemetria: `plugin_manifests`, `trigger_definitions`, `session_tokens`, `heatmap_cells`); `0001` adicionou `password_reset_tokens`; **`0002` criou as 28 restantes** (domínio de teste/build, participação/sessão, feed/gamificação, relatórios, comunidade, notificações, `session_recordings` e `idempotency_keys`); `0003` adicionou o índice de `session_recordings.session_id`. `telemetry_events` (particionada por dia) continua na migração **manual** em `drizzle/manual/`.

Enums: os **16 do design** estão criados — `asset_kind`, `build_status`, `build_step_key`, `game_status`, `membership_status`, `participation_status`, `post_status`, `processing_status`, `question_type`, `recording_kind`, `report_stage`, `session_status`, `test_model_key`, `test_status`, `trigger_type`, `wizard_step`.

Índices/UNIQUEs dos invariantes já criados em `0002`: `participations_active_test_user_unique` (UNIQUE parcial por status ativo), `tests_publish_idempotency_key_unique`, `form_responses_session_unique` e `xp_events_source_unique`.

Ressalvas sobre o que existe mas **não é usado de ponta a ponta**:

- **`game_assets`** — tabela criada e consumida pelo fluxo de upload de capa/banner/screenshot.
- **`audit_log`** — escrita pelo `AuditInterceptor` e exposta via `GET /audit-logs` (paginação por cursor + filtros `actorUserId`/`action`/`from`/`to`, owner/admin).
- **`session_recordings`** — consumida pelo fluxo de upload/playback do M9. Gravação ausente **não** derruba a sessão (Tela 12 RN-03).
- **`plugin_manifests.build_id`** — dívida **quitada**: `0002` criou a FK para `builds(id)`.
- **`idempotency_keys`** — tabela migrada, mas **sem uso**: o `IdempotencyInterceptor` é só Redis. O M15-02 (idempotência durável) segue em aberto.
- **`tests`, `test_audience_criteria`, `test_form_questions`, `test_form_options`, `builds`, `build_validation_steps`** — consumidas de ponta a ponta pelo wizard do M5 (o worker `build.validate` inclusive).
- **Todas as demais tabelas de `0002`** (`participations`, `sessions`, `session_*`, `form_*`, `player_preferences`, `feed_ranking_snapshots`, `xp_events`, `achievements`, `player_achievements`, `missions`, `player_missions`, `ranking_snapshots`, `test_report_snapshots`, `game_reviews`, `community_posts`, `community_reports`, `notifications`) — **migradas e vazias**, aguardando os módulos M6–M8 e M10–M14.

### ⬜ A criar

Nenhuma. O modelo de dados do `schema.dbdiagram.sql` está inteiramente migrado; o trabalho restante é de aplicação.

---

## 4. Pontos de atenção do design (invariantes que a implementação precisa respeitar)

Estes já estão documentados no contrato e no SQL; valem como requisitos ao implementar cada peça. Os itens 2 e 3 **já têm o respaldo no banco** (índices criados em `0002`) — falta a implementação usá-los:

1. **`tests.slots_taken` é contador concorrente** — usar `UPDATE ... WHERE slots_taken < slots_total` checando linhas afetadas; nunca `SELECT` seguido de `UPDATE`.
2. **`participations` tem UNIQUE parcial** em `(test_id, user_id)` enquanto o status for ativo (`participations_active_test_user_unique`) — é o que impede duas participações simultâneas (Tela 14 RN-02); tratar o 23505 como 409.
3. **Idempotência real vem de UNIQUE nas tabelas de recurso** (`tests.publish_idempotency_key`, `form_responses.session_id`, `xp_events (user_id, source_type, source_id)` — os três já criados), não só da tabela `idempotency_keys`/Redis.
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

Seguindo as dependências do domínio (cada linha destrava a próxima). Como o schema já está todo migrado, cada item abaixo é só controller/service/repository/DTO (+ workers onde indicado):

1. ~~**M4 test-models** (catálogo, sem dependência pesada).~~ **Feito.**
2. ~~**M5 tests** (wizard sobre `tests`/`test_*`, worker `build.validate` sobre `builds`/`build_validation_steps`).~~ **Feito.** A ponta solta de M3 `/games/{id}/tests` destrava sozinha agora — não há mais trabalho independente ali; `/games/{id}/achievements` segue esperando o M12.
3. **M6 builds** (o que sobrou depois do wizard): `GET /builds/{id}`, `.../compatibility`, `.../download-url`.
4. **M7/M8** (jogador): feed, participações, sessões, consentimentos + worker de validação de sessão (gatilho de XP).
5. **M10 reports** (depende de sessões existirem; o M9 media já está pronto e esperando por elas).
6. **M11 dashboard, M12 gamificação, M13 comunidade, M14 notificações.**
7. **M15-02** (idempotência durável na tabela `idempotency_keys`) — pode entrar a qualquer momento, a tabela já existe.
