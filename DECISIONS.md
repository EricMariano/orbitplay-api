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
  - `@ffmpeg-installer/ffmpeg` + `@ffprobe-installer/ffprobe` (GAP-04) —
    binários estáticos de ffmpeg/ffprobe por plataforma, para o worker de
    mídia não depender de ffmpeg instalado no host (dev, CI ou produção).
    Deliberadamente **sem** `fluent-ffmpeg`: o pacote está marcado
    `deprecated` no npm; como o uso real é só montar/rodar um `execFile` com
    poucos argumentos fixos (probe, thumbnail, extração de áudio), um
    wrapper próprio (`src/workers/ffmpeg.ts`) evita depender de um pacote
    sem manutenção para algo que não precisa de abstração.
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
- **Chat em tempo real (módulo `chat`) — fora do handoff, pedido do produto.**
  Nem `BACKEND-SPEC.md` nem `openapi.design.yaml` preveem chat: o M13 é o mural
  assíncrono (`community_posts`) + avaliações da Tela 15. O produto pediu uma
  comunidade ao vivo nos moldes do Discord, então entrou um módulo novo em vez
  de esticar o `community` — o mural continua intocado (rotas, contrato e e2e
  existentes não mudaram). Decisões que vão junto:
  - **Socket.IO, não `ws` puro.** Salas, reconexão e ack por evento vêm de
    fábrica; o `@socket.io/redis-adapter` (sobre o `ioredis` que já existia)
    faz um broadcast alcançar todas as réplicas — sem ele, dois jogadores no
    mesmo canal deixariam de se ver assim que houvesse mais de uma instância.
  - **Autenticação só no handshake**, via `auth.token` do access token (o
    header `Authorization` também é aceito para clientes não-browser). Os
    guards globais (`JwtAuthGuard`/`OrgScopeGuard`/`RolesGuard`) passam a
    ignorar contexto não-HTTP, como o `AuditInterceptor` já fazia — não existe
    `request` para ler num evento de socket. Socket sem token é desconectado.
  - **Um canal pertence a um jogo**, como o mural. Conteúdo global: qualquer
    autenticado lê e conversa em canal de qualquer jogo; só o estúdio dono
    cria, edita, arquiva e modera. Moderar jogo alheio é **403, não 404** —
    mesma regra do `CommunityService.moderatePost`.
  - **Qualquer papel fala no chat**, diferente do mural (`@Roles(PLAYER)`). Uma
    comunidade ao vivo em que o estúdio não pode responder não é comunidade; a
    restrição do mural existe para as publicações dos jogadores, não aqui.
  - **REST e socket compartilham o mesmo caminho de escrita**
    (`ChatService.sendMessage`), e o broadcast sai do serviço, não do gateway.
    Assim `POST /chat/channels/:id/messages` chega igual aos sockets abertos, e
    o chat continua utilizável se o WebSocket estiver bloqueado na rede.
  - **Flood control por usuário no Redis** (`CHAT_MESSAGE_THROTTLE_*`). O
    Throttler por IP não serve: a conexão é uma só e persistente, e o limite
    precisa valer para as duas portas de entrada e entre réplicas.
  - **`chat_messages.status` reaproveita o enum `post_status`**
    (`visible | hidden | removed`), para moderar mensagem e moderar publicação
    significarem exatamente a mesma coisa.

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
  `session_validations`/`participations` direto — sem esperar o M7.** Essas
  tabelas já estão migradas (M7-01) mas não têm camada de aplicação ainda; a
  regra "só quem concluiu >=1 sessão válida" (Tela 15) é implementada como uma
  consulta direta a essas tabelas em `CommunityRepository.hasValidSessionForGame`,
  não como um stub. Hoje ela sempre nega (nenhuma sessão real existe), e passa
  a valer sozinha assim que o M7 popular essas linhas — sem exigir revisão
  desta rota depois.
- **M6 (builds) — compatibilidade compara só `platform`; `download-url`
  reaproveita o padrão pré-M7 do M13 para participação ativa.**
  `builds.platform` é texto livre (gravado pelo M5 a partir de
  `platformValues`), sem colunas de `os`/`arch` — `GET /builds/{id}/compatibility`
  aceita `os`/`arch` na query (o contrato pede) mas só compara `platform`;
  incompatibilidade nunca é erro, é `200` com `compatible:false` +
  `reasons[]` legíveis (RN-03/RN-05, Telas 14/15). `GET /builds/{id}/download-url`
  consulta `participations` direto para a checagem de participação ativa —
  mesma tabela do M7 (já migrada), mesmo padrão pré-M7 já registrado para
  `CommunityService.createReview`: nega sempre até o M7 popular linhas reais,
  sem stub, e passa a valer sozinho quando M7 existir. O `409` de
  "dispositivo incompatível" que o design declara nessa rota não tem, hoje,
  como checar dispositivo de verdade — não há `platform` na query dessa rota
  (diferente de `/compatibility`) nem perfil de dispositivo persistido (isso
  é `PATCH /sessions/{id}/devices`, M7). Por ora o `409` cobre a build ainda
  não `validated` — um gate real e honesto, só que mais estreito que "todo o
  dispositivo" até o M7 existir; não requer revisitar esta rota depois, só
  ganha um segundo motivo de `409`.
- **Bug real encontrado e corrigido: `isUniqueViolation` só olhava
  `err.code`.** O Drizzle envelopa o erro do driver num `DrizzleQueryError`
  cujo `.code` próprio é `undefined` — o `PostgresError` real (com `.code`)
  fica em `.cause`. `CommunityService.isUniqueViolation` agora checa os dois.
  O mesmíssimo helper em `tests.service.ts` (M5, usado no fallback de
  `publish()`) tem o bug idêntico, mas nunca foi pego pelos testes porque o
  `IdempotencyInterceptor` intercepta a repetição por `Idempotency-Key` antes
  de chegar no service — ver task sinalizada para corrigir lá também.
- **Bug real encontrado e corrigido: catálogo do M4 contradizia o gate real
  do wizard (GAP-03).** `ab_test` prometia "duas builds válidas, uma por
  variante", mas a plataforma só suporta uma build por teste (§1.3, reforçado
  pelo UNIQUE em `builds.test_id`) — corrigido para descrever a mecânica
  real: cada teste é uma variante com sua própria build, e o comparativo
  entre variantes é feito com um segundo teste, no relatório. `ab_test_images`
  já prometia "sem exigir um build jogável", mas `pendingValidationsFor`
  exigia build validada incondicionalmente para todo modelo — `TestModel`
  ganhou a flag `requiresBuild` (só `false` em `ab_test_images`) e o gate de
  `BUILD_NOT_VALIDATED` agora a consulta em vez de assumir `true` sempre.
- **Gap real encontrado e corrigido: `media.transcode`/`media.extract-audio`
  eram passthrough (GAP-04).** Qualquer objeto virava `ready` sem nenhuma
  verificação real, e a "extração de áudio" só copiava os bytes do vídeo
  inteiro. Os dois jobs agora rodam ffmpeg/ffprobe de verdade
  (`src/workers/ffmpeg.ts`): `transcode` valida que o objeto tem um stream de
  vídeo com um codec reconhecido (rejeita — `failed` — arquivo corrompido ou
  formato não suportado), grava a duração real (nunca a declarada pelo
  cliente) e gera um thumbnail JPEG de um frame real; `extract-audio`
  reencoda a trilha de áudio para AAC (uma extração de verdade) e pula sem
  erro quando não há trilha de áudio (consentimento de microfone negado é
  caso legítimo, não falha). Testado com vídeos VP8/Opus reais gerados pelo
  próprio ffmpeg em `test/helpers/sample-media.ts` (sem fixture binária no
  repo) — `src/workers/media.processor.spec.ts` e `test/media.e2e-spec.ts`
  afirmam sobre duração/codec/áudio/thumbnail reais, não apenas "não
  quebrou".
- **Gap real encontrado e corrigido: FKs simples permitiam relações
  cross-org (DAT-03).** `tests.game_id → games.id`, `builds.test_id →
  tests.id` e `game_assets.game_id → games.id` eram FKs de uma coluna só —
  nada no banco impedia um `test` com `organization_id = A` apontar para um
  `game` de B (idem build→test e asset→game). A aplicação sempre filtra por
  org, então isso nunca acontece pelo caminho normal da API, mas não era uma
  garantia do banco — só da aplicação lembrar de checar sempre. Cada tabela
  "pai" ganhou um UNIQUE composto `(id, organization_id)`
  (`games_id_org_unique`, `tests_id_org_unique`) e cada FK virou composta —
  `(game_id, organization_id) → games(id, organization_id)` etc. — via
  `foreignKey()` do drizzle-orm em vez do `.references()` de uma coluna só.
  Agora um INSERT/UPDATE cross-org falha com violação de FK, não só com um
  bug de aplicação não escrito ainda. Migração `0005` gerada por
  `drizzle-kit generate` precisou de reordenação manual (`CREATE UNIQUE
  INDEX` antes dos `ADD CONSTRAINT` que os referenciam — drizzle-kit não
  garante essa ordem dentro da mesma migração) — testado de ponta a ponta
  (migração + seed + um INSERT cross-org rejeitado de propósito) num
  Postgres descartável antes de commitar.
- **M12 (gamificação) — curva de XP/nível é placeholder; `feedbackQuality`
  fica `0`; catálogo de `achievements`/`missions` ganhou seed com copy
  placeholder (mesmo status do M4).** `BACKEND-SPEC.md` §9 pendência #4
  (fórmulas de XP/nível/qualidade de feedback) segue aberta — `XP_PER_LEVEL`
  (`dto/gamification.dto.ts`) é um degrau linear de 100 XP por nível,
  isolado numa função só para trocar quando a fórmula real chegar.
  `feedbackQuality` depende da avaliação do estúdio sobre a sessão
  (`POST /sessions/{id}/rate`, M10) e de completude das respostas — nenhuma
  das duas existe ainda, então fica `0` até lá, sem inventar dado.
  `hoursPlayed`/`testsCompleted`, ao contrário, são leitura real de
  `sessions`/`participations`/`session_validations` — mesmo padrão pré-M7 já
  registrado para `CommunityService.createReview` e para
  `BuildsService.getDownloadUrl`: sempre `0` hoje (nenhuma sessão real
  existe), passam a valer sozinhos quando o M7 existir. `achievements` e
  `missions` são tabelas reais (não um catálogo em código, ao contrário do
  M4) mas sem handoff de conteúdo — `seed.ts` ganhou 3 achievements e 2
  missions com `name`/`description` **placeholder**, só para as listas
  terem o que mostrar; substituir quando o conteúdo oficial chegar, sem
  migração. Nenhum motor calcula `player_achievements`/`player_missions`
  ainda (isso é o gatilho transacional pós-validação de sessão do M7/M10,
  fora do escopo do M12) — todo jogador começa com as duas listas
  100% bloqueadas/zeradas até algo escrever essas tabelas.
- **M12 — `PlayerMission.target` é sempre `1`; `progress` vira a fração 0–1
  real da coluna `player_missions.progress`.** O schema migrado não tem
  coluna de meta/threshold em `missions` (só `key`/`name`/`description`/
  `reward_xp`/`expires_at`) — o par `progress`/`target` (inteiros) do design
  não tem de onde vir. Em vez de inventar uma coluna nova, `target` fica
  fixo em `1` e `progress` é o valor normalizado já armazenado.
- **M12 — `GET /rankings` lê de `ranking_snapshots`; nada ainda popula essa
  tabela.** Pendência #5 do `BACKEND-SPEC.md` §9 (escopo/periodicidade do
  ranking de jogadores) segue aberta, e não existe job agendado — a tabela é
  "materializada por um job" por design (comentário em
  `schema/player.ts`), não calculada por request. `GamificationRepository.
  findLatestSnapshot` busca o snapshot mais recente por
  `scope`/`period`/`gameId`; sem nenhum, a rota responde `200` com
  `{ data: [], nextCursor: null, currentUserEntry: null, generatedAt: null
  }` em vez de erro — mesmo padrão pré-job dos itens acima. Paginação sobre
  `entries` (um array jsonb por linha, não uma linha por posição) usa um
  cursor de offset próprio (`encodeOffsetCursor`/`decodeOffsetCursor` em
  `gamification.service.ts`), não o cursor de UUID compartilhado de
  `shared/pagination/pagination.ts` — não há id de linha por entrada do
  ranking para reaproveitar aquele contrato.
- **`GET /games/{id}/achievements` (ponta solta do M3) continua bloqueada
  mesmo com o M12 pronto — não por dependência de endpoint, mas porque
  `achievements` (schema) não tem `game_id`.** É um catálogo global de
  conquistas do jogador, não por jogo; o design pede "conquistas
  configuradas do jogo", que exigiria uma tabela de associação
  jogo↔conquista inexistente hoje. Fora do escopo do M12 — registrado aqui
  para não ficar como surpresa depois.
- **M3 (ponta solta) — `GET /games/{id}/tests` define `tab=active` sem
  handoff que diga o que "ativo" significa.** `openapi.design.yaml` só cita
  o nome do parâmetro; `BACKEND-SPEC.md` §M3 também não define. Leitura
  adotada: "ativo" é o que ainda está sendo preparado ou rodando —
  `draft | published | paused` — excluindo os dois estados terminais
  (`finished`/`expired`); `tab=all` remove o filtro. Um `status=` explícito
  vence o `tab` (narrows further). Mesmo tipo de interpretação já feita para
  `GameSpecs`/`estimatedReach`, onde o handoff não fixa a regra exata —
  revisar se/quando o design chegar. Implementado em
  `TestsController.listByGame` (mora no `TestsController`, não no
  `GamesController`, pelo mesmo motivo do `POST /games/{gameId}/tests`: o
  recurso é `tests`, `games` só empresta o prefixo da rota) — `studio+`
  (`STUDIO_ROLES`), como todo o resto do `TestsController` e como a tabela
  do `BACKEND-SPEC.md` já listava.
