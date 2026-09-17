# DECISIONS

Registro das decisões bloqueantes da seção 1 da instrução de setup e de todo
desvio em relação a ela, com motivo. O que estiver marcado como **premissa** foi
implementado como recomendação por falta de decisão formal e pode ser revisto.

## 1. Decisões bloqueantes (seção 1)

### 1.1 Modelo de organização — **decidido**

Cada usuário que se cadastra **cria a sua própria organização (estúdio)** e se
torna o **Owner** dela; a organização pode então ter membros adicionais
("funcionários") com papéis distintos.

Implementação:

- `organizations` é a fronteira de tenancy; `organizations.owner_user_id` aponta
  para o usuário criador.
- `users` é global (uma pessoa/conta), **sem** `organization_id`.
- `memberships` liga usuário ↔ organização com um `role_id` (`roles`).
- O papel que vale numa requisição é o da **membership ativa**, carregado no
  access token — nunca vindo do corpo (RN-03).

Papéis: `owner`, `admin`, `studio`, `player`.

**Signup paths:**

- `POST /auth/signup/studio` — cria user + organização + membership `owner`
  (token `role=owner`).
- `POST /auth/signup/player` — cria user + **organização pessoal**
  (`Conta de {displayName}`, slug `player-<uuid_sem_hífens>`) + membership
  `player` (token `role=player`). A coluna `owner_user_id` aponta para o próprio
  player (NOT NULL), mas o papel no JWT é `player`, então mutações de estúdio
  (`STUDIO_ROLES`) continuam `403`.
- O seed demo (`player@orbitplay.dev` na org do estúdio) permanece só para
  fixtures de teste — não espelha o fluxo de signup do jogador.

### 1.2 Direção do dinheiro — **decidido**

**Estúdio paga, tester (jogador) recebe.** Sem pagamento implementado nesta
etapa; a `PaymentPort` documenta essa direção e o `FakePaymentAdapter` aprova na
hora com id determinístico. `ChargeRequest` é emitido para a organização
(estúdio).

### 1.3 Modelo A/B — **decidido (design), fora do schema desta etapa**

**Uma build por teste; A/B = dois testes comparados** em relatório.

Nota importante: `builds`, `tests` e `participations` **não** fazem parte da
lista de tabelas desta etapa (seção 7), então **nada foi migrado** para isso
agora. A decisão fica registrada aqui para orientar a etapa que criar essas
tabelas. Consequência prática: `plugin_manifests.build_id` existe como `uuid`
**sem FK** (a tabela `builds` ainda não existe) e ganhará a FK quando `builds`
for criada.

### 1.4 Idade mínima — **decidido**

**18+.** Simplifica consentimento (sem fluxo parental). `users.birthdate` é
armazenado para permitir a verificação de idade no cadastro (o endpoint de
cadastro em si não faz parte desta etapa).

## 2. Desvios em relação à instrução (com motivo)

- **Node 25 no ambiente, alvo Node 22.** O ambiente de desenvolvimento tinha
  apenas Node **v25.1.0** instalado (sem gerenciador de versões para trocar). O
  projeto **tem como alvo Node 22 LTS** (`.nvmrc`, `engines`). Tudo roda em 25
  com uma ressalva (abaixo). Use `nvm use` / `fnm use` para o Node 22.
- **`openapi:generate` roda a partir do build compilado.** Sob **Node 25**, o
  runner `tsx` trava silenciosamente ao criar a aplicação Nest completa (o
  caminho compilado — `node dist/...` — funciona perfeitamente; `tsx` funciona
  para os scripts que não sobem o Nest, como migrate/seed/worker). Para o script
  ser robusto em qualquer Node, `openapi:generate` faz `nest build && node
dist/openapi.js`. Em Node 22 o `tsx` funcionaria direto.
- **`eslint.config.mjs` em vez de `eslint.config.js`.** Flat config em ESM; a
  seção 3 lista `eslint.config.js`. Comportamento idêntico, nome com extensão
  explícita para evitar ambiguidade CJS/ESM.
- **Dependências extras (justificadas):**
  - `dotenv` — carregar `.env` nos scripts fora do Nest (migrate, seed, reset,
    drizzle.config) e no boot.
  - `tsx` — executar scripts TypeScript (migrate/seed/reset/worker em dev) sem
    passo de build.
  - `nodemailer` + `@types/nodemailer` — cliente SMTP do adaptador Mailhog
    (`NotificationPort`).
  - `uuid` — geração de **UUID v7** em aplicação (ids ordenáveis por tempo).
  - `@types/express`, `@eslint/js` — tipos/preset necessários.
- **`typescript@5.9` e `eslint@9` fixados.** No momento do setup, o `latest` do
  npm apontava para `typescript@7` (novo compilador nativo) e `eslint@10`, cedo
  demais para a stack de decorators do Nest. Fixados em versões estáveis
  compatíveis.
- **`telemetry_events` fora do schema Drizzle.** É particionada por dia
  (`PARTITION BY RANGE (received_at)`), que o Drizzle não expressa. Vive em
  `drizzle/manual/0001_telemetry_events_partitioned.sql` (exceção prevista na
  seção 7), aplicada pelo mesmo runner após as migrações geradas. O adaptador
  Postgres da `TelemetryStorePort` fala com ela via SQL cru.
  - **Dedup de reenvio:** o contrato (seção 9) pede `UNIQUE (session_id,
event_id)`. O Postgres exige que um índice único numa tabela particionada
    inclua a chave de partição, então o índice é `(session_id, event_id,
received_at)`; a exatidão entre dias é garantida na ingestão via
    `ON CONFLICT` (não há endpoint de ingestão nesta etapa — só modelo e porta).
- **Valores dev no `.env.example`.** Segredos de JWT e credenciais do MinIO têm
  valores **descartáveis de desenvolvimento** para o fluxo `cp .env.example .env
&& pnpm dev` funcionar de imediato. Não são segredos e nunca devem ir para
  produção. A validação Zod ainda trata toda variável como obrigatória: remover
  uma linha faz o boot falhar apontando a variável (critério de aceite #11).
- **Auditoria persistida antes da resposta.** O `AuditInterceptor` grava o
  registro **antes** de emitir a resposta (engolindo erros para nunca quebrar a
  requisição), garantindo que um crash logo após responder não perca o registro
  — a Tela 20 exige o histórico. É um reforço do "desde já" da seção 10.6.
- **`DELETE /orgs/members/{userId}` é owner/admin, não owner-only.** O
  `BACKEND-SPEC.md` §3 lista o papel como só `owner`. Ao unir merges paralelos
  de duas pessoas (ORB-M2-05/06), uma implementação seguiu o spec à risca
  (owner-only) e a outra acrescentou uma auto-proteção — ninguém altera ou
  remove a própria membership, em `PATCH .../status` **e** `DELETE
/orgs/members/{userId}`. As duas regras juntas exigem essa flexibilização:
  com "owner-only" + auto-proteção, a regra do último owner ativo (RN-03)
  nunca dispararia nesse endpoint — um owner não pode ser simultaneamente quem
  chama e o único owner restante. Manter admin permitido é o que mantém RN-03
  testável de fato nesse endpoint, ao custo de divergir do texto literal do
  spec.

## 3. Notas de implementação relevantes

- **404, não 403, para recurso de outra organização.** Garantido no
  `OrgScopedRepository` (`infra/database/base.repository.ts`): todo acesso é
  filtrado por `organization_id` e id inexistente/de outra org retorna 404. Id
  malformado também vira 404 (nunca 500). Provado nos testes e2e.
- **Rate limit por IP e por identificador.** IP via `ThrottlerGuard`
  (`/auth/login`, `/auth/password/forgot`); identificador (e-mail) via contador
  no Redis no `AuthService` — os dois são necessários (só IP não barra ataque
  distribuído contra uma conta).
- **Login de tempo comparável.** Usuário inexistente também paga um
  `argon2.verify` contra um hash dummy, para não vazar existência de conta por
  tempo de resposta.
- **Gestão de membros é owner-only — premissa.** A RN-01 da Tela 20 permite
  "Admin com permissão específica", mas o projeto não tem permissões por
  usuário: `roles` guarda apenas `key`/`label`, e o `RolesGuard` só compara o
  papel do token. Como a condição não é construível, `PATCH
/orgs/members/{userId}/role` exige `owner`. Abrir para `admin` depois é
  aditivo (uma linha de decorator); fechar depois tiraria acesso já concedido.
  Revisar se o produto definir permissões por usuário.
- **Só um owner concede `owner`.** Vale no convite (`POST
/orgs/members/invite`, onde `admin` pode convidar mas não como owner) e deve
  valer em qualquer rota futura que atribua papel. Sem isso um admin convida um
  endereço próprio como owner, ou promove alguém que convidou, e assume a
  organização.
- **`organizations.owner_user_id` não é atualizado na troca de papel —
  pendente.** Há duas fontes possíveis para "quem é o dono": essa coluna
  (singular, `NOT NULL`) e as memberships com papel `owner` (várias). A RN-03
  fala em "último Owner ativo", o que pressupõe várias, então a regra do último
  owner conta memberships `active`. A coluna hoje é **apenas escrita, nunca
  lida** (signup, seed e fixtures), então a divergência é inerte. Falta decidir
  se ela é o dono canônico ou o registro de quem criou a organização — a
  segunda leitura é a que combina com as regras, e tornaria o nome
  `created_by_user_id` mais honesto.
- **Membership `invited` não conta como owner ativo.** "Último Owner **ativo**"
  é `status = 'active'`: um owner convidado ainda não consegue entrar
  (`findActiveMembership` exige `active`), então contá-lo permitiria rebaixar o
  único owner real e deixar a organização sem ninguém que possa agir.
- **Catálogo de `GET /test-models` (M4) é estático no código, com copy
  placeholder.** `src/modules/test-models/test-models.catalog.ts` não lê de
  tabela nem de env — é uma constante em memória, como o `BACKEND-SPEC.md`
  pede ("requisitos técnicos vêm da configuração do backend"). `name`,
  `description`, `deliverables` e `technicalRequirements` dos 4 modelos são
  texto **provisório**, sem handoff de produto/Figma para essa tela; os campos
  que o contrato de fato governa (`key`, `requiresTelemetry`,
  `available`/`unavailableReason`) seguem `BACKEND-SPEC.md` §M4 à risca —
  `free_exploration_telemetry` é o único `available:false` (Orbit Plug-in
  deferido, §10). Substituir a copy quando o conteúdo oficial chegar; não
  requer migração.
- **M5 (wizard de testes) expõe os enums do Drizzle, não os do
  `openapi.design.yaml`.** O design ficou desatualizado em relação à migração
  0002: `TestStatus` no design é `draft/active/paused/closed/expired`, o banco
  tem `draft/published/paused/finished/expired`; o mesmo vale para
  `QuestionType` (`open_text`/`nps` no banco vs. `short_text`/`rating` no
  design) e para `Build.status`/`ValidationStep.status`/`.key`
  (`plugin_manifest` no banco vs. `platform_support` no design). Como em todo
  o resto do projeto, o schema já migrado é a fonte da verdade — a API expõe
  os valores do enum diretamente, sem camada de tradução. `PendingValidation`
  segue o formato do design (`{step, code, message}`); o `422` de
  `POST /tests/{id}/publish` usa `fieldErrors` (`code → message`) porque o
  `HttpExceptionFilter` só repassa `code`/`message`/`fieldErrors` de qualquer
  exceção.
- **`estimatedReach` (Etapa 4) é calculado de verdade, com o que existe hoje.**
  Conta jogadores ativos (`memberships.role = player`, `status = active`) cuja
  `birthdate` cai dentro de `[ageMin, ageMax]`, limitado a `quantity`.
  `locations`/`archetypes`/`deviceRequirements` são persistidos mas **não**
  filtram a contagem — `users` não tem essas colunas nesta fase (mesmo padrão
  de stub documentado do `GameSpecs`). Zero jogadores elegíveis →
  `estimatedReach: 0`, que é o que bloqueia o publish (RN-01), não uma
  validação especial na própria rota de audiência.
- **Uma build por teste é regra de aplicação, não de schema.** `builds` não
  tem UNIQUE em `test_id` (DECISIONS.md §1.3 já registrava isso). O confirm
  (`POST /tests/{id}/build`) troca automaticamente uma build `failed`
  (RN-05 — falha permite nova tentativa sem passo extra); uma build
  `processing`/`validated` exige `DELETE /tests/{id}/build` explícito antes de
  enviar outra. Depois de publicado, tanto o confirm quanto o DELETE recusam
  com `409` — a build fica congelada.
- **`currentStep` só anda para frente.** Cada etapa bem-sucedida avança o
  ponteiro para, no mínimo, a próxima etapa; editar uma etapa já concluída
  (ex.: trocar o modelo depois de já ter enviado o formulário) não retrocede o
  wizard. A única exceção é `DELETE /tests/{id}/build`, que volta o ponteiro
  para `build` de propósito — build removida é build que precisa ser reenviada
  antes de seguir. `pendingValidations` é sempre recalculado a partir dos
  dados reais (não do `currentStep`), então ele é o que de fato bloqueia o
  publish.
- **`POST /tests/{id}/publish` responde `200`, não `201`.** É uma transição de
  estado sobre um recurso que já existe (`draft` → `published`), não uma
  criação — segue o mesmo raciocínio de `PATCH`. Um teste já publicado
  responde `200` com o estado atual em qualquer `Idempotency-Key`, mesmo uma
  nova: a garantia forte contra duplicar é o UNIQUE em
  `tests.publish_idempotency_key`, não a comparação de chave em si.
- **M13 (comunidade) — `post_status` real é `visible|hidden|removed`, não o
  `visible|hidden|pinned` do `openapi.design.yaml`.** O enum migrado
  (`enums.ts`) não tem coluna nem estado para "fixado" — divergência do mesmo
  tipo já registrada para `DELETE /orgs/members/{userId}` (§2) e para os enums
  do M5 (acima). `PATCH /community/posts/{id}/moderate` segue o schema real:
  `action` é `hide | restore | remove` (não `hide | restore | pin | unpin`).
  `hide`→`hidden`, `restore`→`visible`, `remove`→`removed`.
- **Comunidade/avaliações são o primeiro conteúdo lido fora da própria org.**
  Todo o resto da API é `organization_id`-scoped (RN-01): um token só lê/edita
  recursos da própria org, cross-org vira 404. `community_posts`/`game_reviews`
  não têm `organization_id` — são conteúdo público de um jogo, lido por
  qualquer usuário autenticado de qualquer org. Isso exigiu um método novo,
  deliberadamente fora do padrão `OrgScopedRepository`:
  `GamesRepository.findByIdAnyOrg` / `GamesService.existsAnyOrg` (existência
  apenas — nunca devolve o `GameView` completo a quem não é dono). A única
  rota que segue tenancy de fato é a moderação: só `studio+` da organização
  **dona do jogo** modera, e quem não é dono recebe `403` (não `404` — o post
  é público, só não é moderável por quem não é dono; é a resposta que o
  próprio `openapi.design.yaml` já declara para essa rota).
- **Elegibilidade de `POST /games/{gameId}/reviews` consulta `sessions`/
  `session_validations`/`participations` direto — sem esperar o M8.** Essas
  tabelas já estão migradas (M8-01) mas não têm camada de aplicação ainda; a
  regra "só quem concluiu >=1 sessão válida" (Tela 15) é implementada como uma
  consulta direta a essas tabelas em `CommunityRepository.hasValidSessionForGame`,
  não como um stub. Hoje ela sempre nega (nenhuma sessão real existe), e passa
  a valer sozinha assim que o M8 popular essas linhas — sem exigir revisão
  desta rota depois.
- **Bug real encontrado e corrigido: `isUniqueViolation` só olhava
  `err.code`.** O Drizzle envelopa o erro do driver num `DrizzleQueryError`
  cujo `.code` próprio é `undefined` — o `PostgresError` real (com `.code`)
  fica em `.cause`. `CommunityService.isUniqueViolation` agora checa os dois.
  O mesmíssimo helper em `tests.service.ts` (M5, usado no fallback de
  `publish()`) tem o bug idêntico, mas nunca foi pego pelos testes porque o
  `IdempotencyInterceptor` intercepta a repetição por `Idempotency-Key` antes
  de chegar no service — ver task sinalizada para corrigir lá também.
