# OrbitPlay API — Cards do Kanban

> Backlog pronto para virar cards. Derivado de `docs/STATUS-IMPLEMENTACAO.md`,
> `docs/openapi.design.yaml` e `docs/schema.dbdiagram.sql`.
>
> **Como usar:** cada `###` é um card. Copie título + corpo. Sugestão de colunas:
> `Backlog → A fazer → Em progresso → Review → Concluído`.
>
> **Convenções dos cards**
>
> - **ID:** `Mxx-NN` (módulo + sequência).
> - **Labels:** `backend`, `db`, `api`, `infra`, `auth`, `player`, `studio`.
> - **Estimativa:** P (≤1d) · M (1–3d) · G (3–5d) · GG (>5d, quebrar).
> - **DoD padrão (todo card):** migração gerada via `pnpm db:generate` (nunca SQL na mão), endpoint documentado no OpenAPI gerado, testes e2e verdes, tenancy por organização aplicada, erros no envelope único.

---

## Épico M1 — Auth (fechar pendências)

### ORB-M1-01 · Tabela `password_reset_tokens` + fluxo de reset completo

- **Labels:** backend, db, auth · **Estimativa:** M · **Depende de:** —
- **Contexto:** hoje `POST /auth/password/forgot` é stub (manda e-mail sem gerar token). Falta a tabela e o `reset`.
- **Escopo:**
  - [x] Criar tabela `password_reset_tokens` (uso único, `expires_at`, `used_at`) no schema Drizzle + migração.
  - [x] Completar `POST /auth/password/forgot`: gerar token, resposta **sempre genérica** (RN-05), rate limit.
  - [x] Implementar `POST /auth/password/reset`: consome token único; token inválido/expirado/usado → `422`.
  - [x] Ao redefinir, **revogar todas as sessões ativas** do usuário.
- **Aceite:** reset ponta a ponta; token não reutilizável; sessões antigas invalidadas.

### ORB-M1-02 · `POST /auth/signup/studio`

- **Labels:** backend, api, auth · **Estimativa:** M · **Depende de:** —
- **Escopo:**
  - [x] Criar user + organization + membership `owner` em **uma transação**.
  - [x] Validar idade mínima 18 (server-side, `birthdate`).
  - [x] E-mail duplicado → `409`; retorno `LoginResponse` (já loga).
- **Aceite:** conta criada e sessão aberta atomicamente; rollback em falha parcial.

### ORB-M1-03 · `POST /auth/signup/player`

- **Labels:** backend, api, auth · **Estimativa:** P · **Depende de:** M1-02 (reaproveita)
- **Escopo:**
  - [x] Criar user + organização pessoal + membership `player` em **uma transação**.
  - [x] Validar idade mínima 18 (server-side, `birthdate`).
  - [x] E-mail duplicado → `409`; retorno `LoginResponse` (já loga).
- **Aceite:** conta criada e sessão aberta atomicamente; token com `role=player`.

### ORB-M1-04 · `GET /auth/signup/availability`

- **Labels:** backend, api, auth · **Estimativa:** P · **Depende de:** —
- **Escopo:**
  - [x] Checagem de e-mail com resposta pobre (`{ available }`) + **rate limit agressivo** (anti-enumeração: IP + e-mail).
- **Aceite:** feedback de formulário sem metadados extras; 429 sob abuso.

---

## Épico M2 — Orgs & Membros

### ORB-M2-01 · Paginação e filtros em `GET /orgs/members`

- **Labels:** backend, api, studio · **Estimativa:** M · **Depende de:** —
- **Contexto:** endpoint existe mas sem paginação/filtros (marcado `partial`).
- **Escopo:** `?limit=&cursor=` (`{data,nextCursor}`), filtros `q` (nome/e-mail), `role`, `status`.

### ORB-M2-02 · `PATCH /orgs/current`

- **Labels:** backend, api, studio · **Estimativa:** P · **Depende de:** —
- **Escopo:** atualizar dados da org; papéis `owner`/`admin`; `403` caso contrário.

### ORB-M2-03 · `POST /orgs/members/invite`

- **Labels:** backend, api, studio · **Estimativa:** M · **Depende de:** M1-01 (fluxo de senha)
- **Escopo:** cria membership `invited` + e-mail; **não** cria senha (convidado usa reset); `409` se já é membro.

### ORB-M2-04 · `PATCH /orgs/members/{userId}/role`

- **Labels:** backend, api, studio · **Estimativa:** M · **Depende de:** M2-06
- **Escopo:** exige `confirm:true` (RN-02); rebaixar **último owner ativo** → `409` (RN-03); grava `audit_log` (RN-05).

### ORB-M2-05 · `PATCH /orgs/members/{userId}/status`, `DELETE /orgs/members/{userId}`, `POST .../password-reset`

- **Labels:** backend, api, studio · **Estimativa:** M · **Depende de:** M2-06
- **Escopo:** ativar/desativar (lógico); desativar/remover **último owner** → `409`; disparo de reset (admin nunca vê senha).

### ORB-M2-06 · Expor `GET /audit-logs`

- **Labels:** backend, api, studio · **Estimativa:** P · **Depende de:** —
- **Contexto:** tabela `audit_log` já existe e é escrita; falta o endpoint de leitura.
- **Escopo:** listagem paginada, escopo por org, filtros `actorUserId`, `action`, `from`, `to`; papéis `owner`/`admin`.

---

## Épico M3 — Games (fechar pendências)

### ORB-M3-01 · Métricas agregadas + filtros em `GET /games`

- **Labels:** backend, api, studio · **Estimativa:** M · **Depende de:** M5 (tests) para métricas reais
- **Escopo:** `GameMetrics` (testsTotal/active, sessionsValid, playersTotal, averageRating) agregado no backend; filtros `q`, `status`, paginação. _(Métricas dependentes de testes podem entrar zeradas até M5.)_

### ORB-M3-02 · Upload de assets do jogo (`game_assets`)

- **Labels:** backend, api, infra, studio · **Estimativa:** G · **Depende de:** —
- **Contexto:** tabela `game_assets` existe **sem uso**; fluxo é trabalho novo de ponta a ponta.
- **Escopo:**
  - [ ] `POST /games/{id}/assets/upload-url` — valida `contentType`/`sizeBytes`, devolve URL assinada (sem proxy de binário).
  - [ ] `POST /games/{id}/assets` — confirma objeto no storage antes de gravar a linha.
  - [ ] `DELETE /games/{id}/assets/{assetId}`.

### ORB-M3-03 · Telas de leitura do jogo

- **Labels:** backend, api, studio · **Estimativa:** M · **Depende de:** M5
- **Escopo:** `GET /games/{id}/summary`, `.../tests`, `.../achievements`, `.../specs`.

---

## Épico M4 — Catálogo de modelos de teste

### ORB-M4-01 · `GET /test-models` e `GET /test-models/{key}`

- **Labels:** backend, api · **Estimativa:** M · **Depende de:** —
- **Escopo:** catálogo com requisitos técnicos vindos da config; `free_exploration_telemetry` retorna `available:false` + `unavailableReason` (plug-in deferido).

---

## Épico M5 — Testes / Wizard (núcleo do estúdio)

### ORB-M5-01 · Schema do domínio de testes

- **Labels:** backend, db · **Estimativa:** G · **Depende de:** —
- **Escopo:** migração de `tests`, `test_audience_criteria`, `test_form_questions`, `test_form_options` + enums (`test_status`, `wizard_step`, `test_model_key`, `question_type`, `report_stage`).
- **Atenção:** UNIQUE `tests.publish_idempotency_key`; UNIQUE `(test_id, position)` nas perguntas; `slots_taken` como contador concorrente.

### ORB-M5-02 · Rascunho do wizard: criar e ler teste

- **Labels:** backend, api, studio · **Estimativa:** M · **Depende de:** M5-01
- **Escopo:** `POST /games/{gameId}/tests` (nasce `draft`), `GET /tests/{id}` com `currentStep` + `pendingValidations` decididos no backend.

### ORB-M5-03 · Etapa 1 — modelo (`PATCH /tests/{id}/model`)

- **Labels:** backend, api · **Estimativa:** P · **Depende de:** M5-02, M4-01
- **Escopo:** seleção única/obrigatória; modelo indisponível → `422`.

### ORB-M5-04 · Etapa 2 — formulário (`PUT /tests/{id}/form` + preview)

- **Labels:** backend, api · **Estimativa:** M · **Depende de:** M5-01
- **Escopo:** substitui o conjunto inteiro de perguntas em **uma transação** (reordenação atômica); `position` é autoridade; tipos com opções exigem mínimo; `GET .../form/preview`.

### ORB-M5-05 · Etapa 3 — build (upload + validação)

- **Labels:** backend, api, infra · **Estimativa:** G · **Depende de:** M6-01
- **Escopo:** `POST /tests/{id}/build/upload-url`; `POST /tests/{id}/build` enfileira `build.validate` (retorna `202 processing`); `GET`/`DELETE` da build; falha preserva formulário e traz `failureReason`.

### ORB-M5-06 · Etapa 4 — público (`PATCH /tests/{id}/audience`)

- **Labels:** backend, api · **Estimativa:** M · **Depende de:** M5-01
- **Escopo:** valida `ageMin<=ageMax` (18+), calcula `estimatedReach` (>0 para publicar).

### ORB-M5-07 · Etapa 5 — publicar (`POST /tests/{id}/publish`)

- **Labels:** backend, api · **Estimativa:** M · **Depende de:** M5-03..06
- **Escopo:** `Idempotency-Key` **obrigatório** (recarregar não cria 2º teste — via UNIQUE); `422` listando `pendingValidations` se etapa incompleta.

### ORB-M5-08 · `PATCH /tests/{id}/status` (pausar/encerrar)

- **Labels:** backend, api · **Estimativa:** P · **Depende de:** M5-07
- **Escopo:** transições válidas; transição inválida → `409`.

---

## Épico M6 — Builds

### ORB-M6-01 · Schema `builds` + `build_validation_steps`

- **Labels:** backend, db · **Estimativa:** M · **Depende de:** —
- **Escopo:** tabelas + enums (`build_status`, `build_step_key`, `processing_status`); validação como **lista de etapas** (não booleano). Quitar dívida da FK `plugin_manifests.build_id`.

### ORB-M6-02 · Worker de validação de build

- **Labels:** backend, infra · **Estimativa:** G · **Depende de:** M6-01
- **Escopo:** job `build.validate` (checksum, malware_scan, metadata); `plugin_manifest` fica como etapa futura (enum já reserva).

### ORB-M6-03 · Compatibilidade e download

- **Labels:** backend, api, player · **Estimativa:** M · **Depende de:** M6-01, M8-01
- **Escopo:** `GET /builds/{id}` , `GET /builds/{id}/compatibility` (incompatível = `compatible:false`, não erro), `GET /builds/{id}/download-url` (participação ativa + compatível; suporta `Range`; `localVersion`).

---

## Épico M7 — Feed do jogador

### ORB-M7-01 · Schema de feed/preferências

- **Labels:** backend, db, player · **Estimativa:** M · **Depende de:** M5-01
- **Escopo:** `player_preferences`, `feed_ranking_snapshots`.

### ORB-M7-02 · Feed rankeado com ranking congelado

- **Labels:** backend, api, player · **Estimativa:** GG (quebrar) · **Depende de:** M7-01
- **Escopo:** `GET /player/feed` com cursor de **ranking congelado por sessão** (seed + snapshot TTL; expirado → `422`); slots (`organic`/`promoted`); elegibilidade (`disabled`+`disabledReason`); trilhos `for_you/new/ending_soon/popular`.

### ORB-M7-03 · Home, filtros e detalhes do jogador

- **Labels:** backend, api, player · **Estimativa:** G · **Depende de:** M7-02, M8-01
- **Escopo:** `GET /player/home`, `/player/feed/filters`, `/player/games/{gameId}`, `.../tests`, `/player/tests/{testId}` (com `cta` calculado no backend), `/player/participations`.

---

## Épico M8 — Participações & Sessões

### ORB-M8-01 · Schema participações/sessões

- **Labels:** backend, db · **Estimativa:** G · **Depende de:** M5-01
- **Escopo:** `participations`, `session_consents`, `sessions`, `session_device_events`, `session_validations`, `form_responses`, `form_answers` + enums (`participation_status`, `session_status`).
- **Atenção:** UNIQUE parcial `(test_id, user_id)` enquanto ativo (barra participação dupla); `t_ms` como base temporal única.

### ORB-M8-02 · Entrar no teste (`POST /player/tests/{testId}/participations`)

- **Labels:** backend, api, player · **Estimativa:** M · **Depende de:** M8-01, M5-07
- **Escopo:** valida elegibilidade/vagas/prazo/compatibilidade **no servidor**; `slots_taken` via `UPDATE ... WHERE slots_taken<slots_total`; `Idempotency-Key` (repetição devolve a existente; sem chave, 2º pedido → `409`).

### ORB-M8-03 · Consentimentos + tutorial

- **Labels:** backend, api, player · **Estimativa:** M · **Depende de:** M8-01
- **Escopo:** `POST /participations/{id}/consents` (prova legal: quem/o quê/quando/IP, append-only; obrigatório recusado → `422`); `GET .../tutorial` (por modelo).

### ORB-M8-04 · Ciclo de vida da sessão

- **Labels:** backend, api, player · **Estimativa:** G · **Depende de:** M8-03, M6-03
- **Escopo:** `POST /participations/{id}/sessions` (só após build validada + consentimentos); `PATCH /sessions/{id}/devices` (com `tMs`); `POST /sessions/{id}/heartbeat` (timeout → incompleta); `POST /sessions/{id}/finish` (`confirmed:true`, enfileira `session.validate`, vai a `in_review`).

### ORB-M8-05 · Avaliação da sessão + resultado

- **Labels:** backend, api, player · **Estimativa:** M · **Depende de:** M8-04
- **Escopo:** `GET /sessions/{id}/summary`; `POST /sessions/{id}/form-response` (obrigatórias → `422 fieldErrors`; UNIQUE por `session_id`; idempotente); `GET /participations/{id}/result` (XP/nota só pós-validação; leitura pura).

### ORB-M8-06 · Worker de validação de sessão (gatilho de XP/recompensa)

- **Labels:** backend, infra · **Estimativa:** G · **Depende de:** M8-04, M12-01
- **Escopo:** `session.validate` → insert **único e transacional** em `session_validations`; credita XP via `xp_events` (UNIQUE composta impede duplicar); `reward_status=pending` (carteira deferida).

---

## Épico M9 — Mídia / Gravação

### ORB-M9-01 · Schema `session_recordings`

- **Labels:** backend, db · **Estimativa:** P · **Depende de:** M8-01
- **Escopo:**
  - [x] Tabela + enums `recording_kind` (`screen | webcam | microphone`) e `processing_status`.
  - [x] OpenAPI (`screen_recording | audio | microphone | webcam`) mapeado na API — sem terceiro enum. `audio` é consentimento/sidecar, não `kind`.
  - [x] Comentário no schema: gravação ausente não derruba a sessão (Tela 12 RN-03).
  - [x] Índice em `session_id`; FK `ON DELETE CASCADE`.

### ORB-M9-02 · Upload multipart + processamento

- **Labels:** backend, api, infra · **Estimativa:** G · **Depende de:** M9-01
- **Escopo:**
  - [x] `POST /sessions/{id}/recordings/upload-url` (multipart por `partNumber`).
  - [x] `POST .../complete` (enfileira `media.transcode` + `media.extract-audio`).
  - [x] `GET .../playback-url` (ausente/processando não é erro: `status` + `url:null`).

---

## Épico M10 — Relatórios do estúdio

### ORB-M10-01 · Schema `test_report_snapshots` (um registro por bloco)

- **Labels:** backend, db · **Estimativa:** P · **Depende de:** M8-01
- **Escopo:** tabela por **bloco** (não payload por teste); métricas só de sessões válidas.

### ORB-M10-02 · Relatório em blocos

- **Labels:** backend, api, studio · **Estimativa:** G · **Depende de:** M10-01, M8-06
- **Escopo:** `GET /tests/{id}/report` (+ `/evolution`, `/ratings`, `/testers` como blocos independentes com `status` próprio); `stage` `partial`/`final`.

### ORB-M10-03 · Sessões do teste e detalhe/avaliação

- **Labels:** backend, api, studio · **Estimativa:** M · **Depende de:** M8-04
- **Escopo:** `GET /tests/{id}/sessions`; `GET /sessions/{id}` (blocos, mesma base `tMs`); `POST /sessions/{id}/rate` (pode marcar inválida → sai das métricas).

### ORB-M10-04 · Exportação (`GET /tests/{id}/report/export`)

- **Labels:** backend, api, infra · **Estimativa:** M · **Depende de:** M10-02
- **Escopo:** export grande roda em job (`202` + jobId; `200` + URL assinada quando pronto); csv/pdf.

---

## Épico M11 — Dashboard do estúdio

### M11-01 · `GET /studio/dashboard`

- **Labels:** backend, api, studio · **Estimativa:** G · **Depende de:** M5, M10
- **Escopo:** KPIs consolidados no backend, filtrados por org/permissão; cache Redis com invalidação por evento de domínio.

### M11-02 · `GET /studio/benchmark`

- **Labels:** backend, api, studio · **Estimativa:** P · **Depende de:** decisão de dados (pendência 7)
- **Escopo:** contrato existe; **bloqueado** até definir a fonte de dados.

---

## Épico M12 — Gamificação

### M12-01 · Schema de gamificação

- **Labels:** backend, db · **Estimativa:** M · **Depende de:** —
- **Escopo:** `xp_events` (ledger append-only, UNIQUE `(user_id,source_type,source_id)`), `achievements`, `player_achievements`, `missions`, `player_missions`, `ranking_snapshots`.

### M12-02 · Endpoints de progresso/conquistas/missões

- **Labels:** backend, api, player · **Estimativa:** M · **Depende de:** M12-01
- **Escopo:** `GET /player/progress` (nível/XP **derivados** da soma, nunca contador), `/player/achievements`, `/player/missions`.

### M12-03 · Ranking materializado (`GET /rankings`)

- **Labels:** backend, api, infra · **Estimativa:** M · **Depende de:** M12-01 · **Pendência:** escopo/periodicidade (5)
- **Escopo:** servido de snapshot por job, nunca calculado na request; `scope=game` exige `gameId`.

---

## Épico M13 — Comunidade

### M13-01 · Schema comunidade/reviews

- **Labels:** backend, db · **Estimativa:** M · **Depende de:** —
- **Escopo:** `community_posts`, `community_reports`, `game_reviews` + enum `post_status`.

### M13-02 · Posts e moderação

- **Labels:** backend, api · **Estimativa:** M · **Depende de:** M13-01, M2-06 (auditoria)
- **Escopo:** `GET|POST /games/{gameId}/community/posts`; `POST /community/posts/{id}/report`; `PATCH .../moderate` (papéis do estúdio dono, gera auditoria).

### M13-03 · Avaliações do jogo

- **Labels:** backend, api · **Estimativa:** M · **Depende de:** M13-01, M8-06
- **Escopo:** `GET|POST /games/{gameId}/reviews` — só quem concluiu ≥1 sessão válida, 1x por jogador (UNIQUE).

---

## Épico M14 — Notificações

### M14-01 · Schema + endpoints de notificações

- **Labels:** backend, db, api · **Estimativa:** M · **Depende de:** — · **Pendência:** confirmar componente in-app no Figma (8)
- **Escopo:** tabela `notifications`; `GET /notifications` (paginado, `unreadOnly`, `unreadCount`); `PATCH /notifications/{id}/read`.

---

## Épico M15 — Infra / Observabilidade

### M15-01 · `GET /health/ready`

- **Labels:** backend, infra · **Estimativa:** P · **Depende de:** —
- **Escopo:** readiness incluindo a fila (BullMQ), além de Postgres/Redis/storage.

### M15-02 · Tabela `idempotency_keys` + interceptor durável

- **Labels:** backend, db, infra · **Estimativa:** M · **Depende de:** —
- **Escopo:** guarda resposta original para reproduzir em repetição (Redis no caso comum; tabela como registro durável). **Nota:** a proteção real contra corrida são as UNIQUE nas tabelas de recurso.

---

## Cards deferidos (§10) — **não** iniciar nesta fase

Criar como cards no fundo do backlog, marcados `deferido`: cobrança do estúdio, carteira/saque do jogador, boost do feed, Orbit Plug-in + telemetria, insights de IA, transcrição (ASR). As tabelas de plug-in/telemetria já existem congeladas.

---

## Ordem sugerida de sprints

1. **Fechar M1/M2/M3** (pendências `partial`) + **M15-02** (idempotência).
2. **M4 + M5-01/02** (base de testes).
3. **M5-03..08 + M6** (wizard e builds completos).
4. **M7 + M8** (jornada do jogador).
5. **M9 + M10** (mídia e relatórios).
6. **M11 + M12 + M13 + M14 + M15-01**.
