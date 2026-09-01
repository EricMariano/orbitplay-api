# OrbitPlay — Especificação de Backend

Documento de escopo funcional do backend: o que precisa existir, quais APIs e
endpoints, quais integrações externas e quais regras de negócio precisam ser
implementadas do lado do servidor.

- **Fonte funcional:** `OrbitPlay_Handoff.docx.pdf` v1.6 (20 telas, RN-xx por tela).
- **Fonte visual:** Figma / Dev Mode (medidas, estados, responsividade).
- **Fonte de dados:** este documento + `openapi.json`.
- **Contrato de API:** [`docs/openapi.design.yaml`](./openapi.design.yaml) —
  OpenAPI 3.0.3 com as 92 operações desta especificação, cada uma marcada com
  `x-status: implemented | partial | todo`. É o documento contra o qual se
  codifica; o `openapi.json` na raiz continua sendo o gerado, refletindo apenas
  o que já roda.

Convenção deste documento: cada endpoint marcado com **[✓]** já existe no
repositório; **[novo]** precisa ser desenvolvido.

---

## 1. Comparação com a API atual

### 1.1 O que já existe

Stack montada em `orbitplay-api`: NestJS 12, Drizzle + Postgres, Zod
(`nestjs-zod`), BullMQ + Redis, MinIO (S3), Mailhog (SMTP), argon2, JWT com
rotação de refresh e detecção de reuso, RBAC, envelope único de erro, paginação
por cursor, auditoria e `openapi.json` versionado.

**13 endpoints implementados** (contrato completo em `openapi.json`):

| Módulo | Endpoints |
| --- | --- |
| `health` | `GET /health` — já verifica Postgres, Redis e storage |
| `iam` | `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/password/forgot` |
| `orgs` | `GET /orgs/current`, `GET /orgs/members` |
| `games` | `GET /games`, `GET /games/:id`, `POST /games`, `PATCH /games/:id`, `DELETE /games/:id` |

**Tabelas existentes:** `users`, `organizations`, `memberships`, `roles`,
`refresh_tokens`, `games`, `game_assets`, `audit_log`, `plugin_manifests`,
`trigger_definitions`, `heatmap_cells`, `session_tokens`, `telemetry_events`
(particionada, em `drizzle/manual/`).

**Portas definidas:** `StoragePort` (MinIO — real), `NotificationPort` (SMTP —
real), `TelemetryStorePort` (Postgres — real), `PaymentPort` (fake, aprova na
hora), `AiPort` (stub), `AsrPort` (stub).

### 1.2 Cobertura por tela do handoff

| # | Tela | Cobertura hoje | O que falta |
| --- | --- | --- | --- |
| 01 | Login — Estúdio e Jogador | **Parcial** | Criar conta e redefinir senha (só o "esqueci" existe, e é stub) |
| 02 | Home Estúdio | **Nenhuma** | Dashboard, KPIs, telemetria, benchmark, testes recentes |
| 03 | Meus jogos | **Parcial** | Filtros, métricas agregadas por card, imagens |
| 04 | Novo jogo | **Parcial** | Upload/validação de capa e banner |
| 05 | Detalhes do meu jogo | **Nenhuma** | Resumo, abas, tabela de testes |
| 06–10 | Wizard de novo teste (5 etapas) | **Nenhuma** | Modelos, formulário, build, público e publicação. Plug-in, orçamento e checkout deferidos (§10) |
| 11 | Relatório | **Nenhuma** | Agregações, gráficos, exportação. Blocos de telemetria e IA deferidos (§10) |
| 12 | Detalhes de teste / sessão | **Nenhuma** | Sessão e vídeo. Transcrição e gatilhos deferidos (§10) |
| 13 | Home Jogador | **Nenhuma** | Progresso, teste em andamento, destaques. Carteira deferida (§10) |
| 14 | Jogos disponíveis para testar | **Nenhuma** | Feed rankeado e elegibilidade. Impulsionamento deferido (§10) |
| 15 | Detalhes de um jogo (jogador) | **Nenhuma** | Abas, CTA por estado, conquistas, comunidade |
| 16 | Tutorial + download da build | **Nenhuma** | Tutorial por modelo, consentimentos, download |
| 17 | Gameplay + sobreposição | **Nenhuma** | Sessão, dispositivos, heartbeat, finalização |
| 18 | Resumo da sessão + formulário | **Nenhuma** | Resumo, transcrição, envio de respostas |
| 19 | Ação enviada + resultado | **Nenhuma** | XP, nota, conquistas. Crédito financeiro deferido (§10) |
| 20 | Central de gerenciamento de usuários | **Parcial** | Só a listagem existe; nenhuma escrita |

**Resumo:** 0 telas completas, 4 parciais, 16 sem nenhum backend.
**79 endpoints a construir** contra **13 existentes** — 92 operações no total, conforme `openapi.design.yaml`.

### 1.3 Armadilhas — o que parece pronto mas não está

Levantado lendo o código, não só a lista de rotas. Cada item abaixo é trabalho
que um planejamento otimista deixaria de fora:

| Item | Situação real |
| --- | --- |
| `POST /auth/password/forgot` | **É um stub.** Envia um e-mail cujo texto diz "fluxo de reset completo virá em etapa futura". Não gera token, não existe tabela `password_reset_tokens` e não existe `POST /auth/password/reset`. A RN-05 da Tela 01 **não** está atendida. |
| Criação de conta | **Não existe endpoint algum.** Usuários só entram pelo `db:seed`. O "Criar nova conta" da Tela 01 é 100% novo, para os dois perfis. |
| `GET /games` | Aceita apenas `limit` e `cursor`. **Sem** filtro por `status`, **sem** busca e **sem** os agregados que o card da Tela 03 exige (RN-03: testes, recompensas, jogadores). |
| `game_assets` | Tabela criada e **nenhuma linha de código a usa**. Não há upload, nem `coverUrl`/`bannerUrl` no `GameDto`. As imagens da Tela 04 são trabalho novo de ponta a ponta. |
| `GET /orgs/members` | Retorna a lista inteira, **sem paginação, filtro ou busca** — a Tela 20 pede busca/filtro. Não existe nenhuma rota de escrita de membro (convite, papel, status, reset). |
| `plugin_manifests`, `trigger_definitions`, `heatmap_cells`, `session_tokens` | Tabelas criadas com o contrato **congelado**, mas **sem nenhum consumidor**: não há endpoint de ingestão, nem parser de manifesto, nem emissão de session token. |
| `telemetry_events` | Tabela particionada e adaptador Postgres prontos, mas **sem endpoint de ingestão** e sem job de manutenção de partições. |
| `PaymentPort` | `FakePaymentAdapter` aprova na hora com id determinístico. **Nenhum gateway real**, nenhum webhook, nenhuma conciliação. |
| `AiPort` / `AsrPort` | Stubs que devolvem valor fixo marcado como `isFake: true`. Nenhuma integração real. |
| `builds` | Tabela **não existe**. Por isso `plugin_manifests.build_id` é um `uuid` **sem FK** — a FK é dívida registrada em `DECISIONS.md` §1.3 e precisa entrar junto com a tabela. |

## 2. Convenções transversais (valem para todo endpoint novo)

| Tema | Regra |
| --- | --- |
| **Tenancy** | Toda leitura/escrita é filtrada por `organization_id` via `BaseRepository`. Serviço nunca filtra à mão. (Tela 02 RN-01, Tela 03 RN-01, Tela 12 RN-01) |
| **Papéis** | `owner`, `admin`, `studio`, `player`. O papel válido vem da **membership ativa carregada no access token** — nunca do corpo da requisição. (Tela 01 RN-03) |
| **Permissão** | Ação não autorizada retorna `403`; a UI esconde/desabilita, mas o backend é a autoridade. (Tela 02 RN-04) |
| **Erros** | Envelope único `{ statusCode, code, message, fieldErrors?, requestId }`. Validação Zod → `422` com erro por campo. |
| **Paginação** | `?limit=&cursor=` → `{ data, nextCursor }`. Cursor opaco sobre UUIDv7. |
| **Idempotência** | Header `Idempotency-Key` **obrigatório** em: publicação de teste, criação de participação, finalização de sessão e envio de formulário. Chave persistida (Redis + coluna única) e resposta original reproduzida em repetição. |
| **Estados de processamento** | Todo recurso que depende de job assíncrono retorna `status: processing \| ready \| failed` **por bloco**, nunca um valor provisório disfarçado de definitivo. (Tela 11 RN-02, Tela 19 RN-02) |
| **Falha parcial** | Relatórios e telas compostas retornam `status` por bloco, para que um bloco quebrado não derrube a página. (Tela 11, Tela 12) |
| **Valores financeiros** | Quando aparecerem (recompensa exibida, valor do teste), sempre em centavos (`amountCents` + `currency`) e sempre vindos do backend. Cobrança e movimentação de dinheiro estão deferidas (§10). |
| **Rate limit** | Já ativo em `auth`. Estender para ingestão de telemetria, uploads e endpoints de escrita do jogador. |
| **Auditoria** | `audit_log` obrigatório em: mudança de papel/status, desativação de conta, pagamento, saque, publicação/encerramento de teste, invalidação de sessão. (Tela 20 RN-05) |
| **LGPD / consentimento** | Gravação de tela, áudio, microfone e webcam exigem consentimento explícito registrado antes da sessão. Plataforma é 18+ (`users.birthdate`). |

---

## 3. Módulos, APIs e endpoints

### M1 — Autenticação e onboarding *(Tela 01)*

| Método | Rota | Papel | Situação |
| --- | --- | --- | --- |
| POST | `/auth/login` | público | [✓] |
| POST | `/auth/refresh` | público (cookie) | [✓] |
| POST | `/auth/logout` | autenticado | [✓] |
| GET | `/auth/me` | autenticado | [✓] |
| POST | `/auth/password/forgot` | público | [✓] |
| POST | `/auth/password/reset` | público (token) | **[novo]** |
| POST | `/auth/signup/studio` | público | **[novo]** — cria user + organização + membership `owner` |
| POST | `/auth/signup/player` | público | **[novo]** — cria user + membership `player`, valida 18+ |
| GET | `/auth/signup/availability?email=` | público | **[novo]** — checagem de e-mail em uso (resposta genérica) |

**Regras**

- RN-01: ID/e-mail e senha obrigatórios.
- RN-02: credencial inválida retorna erro genérico — **nunca** revelar se o
  errado foi usuário ou senha. Mesmo tempo de resposta nos dois casos.
- RN-03: a aba "Sou tester"/"Sou estúdio" é apenas UI. A sessão é criada com o
  papel real da conta; se o usuário escolher a aba errada, a sessão é criada com
  o papel real (ou 403 explícito, se o produto quiser bloquear).
- RN-04: "Lembrar login" altera **apenas o TTL do refresh token**; senha nunca
  em texto simples (argon2 já em uso).
- RN-05: recuperação de senha em fluxo próprio com token de uso único e
  expiração curta; criação de conta inicia o onboarding do perfil escolhido.

---

### M2 — Organizações, membros e central de usuários *(Telas 02 e 20)*

| Método | Rota | Papel | Situação |
| --- | --- | --- | --- |
| GET | `/orgs/current` | autenticado | [✓] |
| GET | `/orgs/members` | studio+ | [✓] — **estender** com `?q=&role=&status=` e paginação |
| PATCH | `/orgs/current` | owner/admin | **[novo]** |
| POST | `/orgs/members/invite` | owner/admin | **[novo]** |
| PATCH | `/orgs/members/:userId/role` | owner (admin se autorizado) | **[novo]** |
| PATCH | `/orgs/members/:userId/status` | owner/admin | **[novo]** — ativar/desativar |
| POST | `/orgs/members/:userId/password-reset` | owner/admin | **[novo]** — dispara e-mail |
| DELETE | `/orgs/members/:userId` | owner | **[novo]** — desativação lógica |
| GET | `/audit-logs?actor=&action=&from=&to=` | owner/admin | **[novo]** |

**Regras** *(Tela 20)*

- RN-01: central exclusiva do Owner; Admin só com permissão específica.
- RN-02: alteração de papel é ação crítica — exige confirmação explícita
  (`confirm: true` no corpo) e é auditada.
- RN-03: **nunca** permitir remover/rebaixar o último Owner ativo → `409`.
- RN-04: senha nunca é exibida nem retornada; só fluxo de redefinição.
- RN-05: alteração de papel, status e dados sensíveis grava `audit_log` com
  autor, data e ação.
- RN-06: preferir desativação lógica à exclusão quando houver histórico de
  testes/pagamentos associado.
- Conflito de edição concorrente → `409` (versão/`updated_at` no payload).

---

### M3 — Jogos do estúdio *(Telas 03, 04, 05)*

| Método | Rota | Papel | Situação |
| --- | --- | --- | --- |
| GET | `/games?status=&q=` | studio+ | [✓] — **estender** com agregados do card |
| GET | `/games/:id` | studio+ | [✓] |
| POST | `/games` | studio+ com permissão de criação | [✓] |
| PATCH | `/games/:id` | studio+ | [✓] |
| DELETE | `/games/:id` | studio+ | [✓] |
| POST | `/games/:id/assets/upload-url` | studio+ | **[novo]** — presigned PUT (capa/banner) |
| POST | `/games/:id/assets` | studio+ | **[novo]** — confirma upload e vincula |
| DELETE | `/games/:id/assets/:assetId` | studio+ | **[novo]** |
| GET | `/games/:id/summary` | studio+ | **[novo]** — banner, disponibilidade, indicadores (Tela 05) |
| GET | `/games/:id/tests?tab=active\|all&status=` | studio+ | **[novo]** — tabela de testes |
| GET | `/games/:id/achievements` | studio+ | **[novo]** |
| GET | `/games/:id/specs` | studio+ | **[novo]** |

**Regras**

- Tela 03 RN-02: criação depende de permissão de edição/gestão do estúdio.
- Tela 03 RN-03: métricas do card são **soma/estado dos testes associados**,
  calculadas no backend.
- Tela 03 RN-04: lista vazia é um estado legítimo (`data: []`), não erro.
- Tela 04 RN-01/02/03: nome obrigatório; jogo sempre criado dentro da
  organização logada; só perfis autorizados criam/editam.
- Tela 04 RN-05: upload de imagem valida **formato, tamanho e falha de envio no
  backend** — a validação do front não conta.
- Tela 05 RN-04: estados de teste e disponibilidade são definidos pelo backend.

> **Pendência:** os campos exatos de "Novo jogo" (Tela 04) dependem do frame
> final do Figma, ainda marcado como pendente no handoff.

---

### M4 — Catálogo de modelos de teste *(Tela 06)*

| Método | Rota | Papel | Situação |
| --- | --- | --- | --- |
| GET | `/test-models` | studio+ | **[novo]** |
| GET | `/test-models/:key` | studio+ | **[novo]** |

Modelos previstos: `free_exploration_telemetry`, `free_exploration`, `ab_test`,
`ab_test_images`.

Payload por modelo: `key`, `name`, `description`, `deliverables[]`,
`technicalRequirements[]`, `requiresTelemetry: boolean`, `available: boolean`,
`unavailableReason?`.

**Regras**

- RN-01/02: seleção única e obrigatória, validadas também no servidor.
- RN-04: `requiresTelemetry` continua no contrato **desde já**, mesmo sem o
  plug-in implementado — é o campo que a Etapa 3 usa para travar o avanço quando
  a telemetria voltar ao escopo.
- **Nesta fase o modelo `free_exploration_telemetry` é retornado com
  `available: false`** e motivo explícito, porque depende do Orbit Plug-in
  (deferido, §10). O campo `unavailableReason` já existe no contrato justamente
  para esse caso — não é preciso inventar um estado novo depois.
- Preço e cobrança saem do escopo desta fase; `GET /pricing` volta junto com
  pagamentos (§10).

---

### M5 — Wizard de criação de teste *(Telas 06 → 10)*

O wizard é um **rascunho persistido no servidor** (`tests.status = 'draft'`),
para que voltar entre etapas não perca dados (Tela 07, estados e validações).
Sem pagamento nesta fase, o wizard termina **publicando o teste diretamente**.

| Método | Rota | Etapa | Situação |
| --- | --- | --- | --- |
| POST | `/games/:gameId/tests` | cria rascunho | **[novo]** |
| GET | `/tests/:id` | qualquer | **[novo]** — inclui `currentStep` e `pendingValidations[]` |
| PATCH | `/tests/:id/model` | 1 | **[novo]** |
| PUT | `/tests/:id/form` | 2 | **[novo]** — substitui o conjunto de perguntas |
| GET | `/tests/:id/form/preview` | 2 | **[novo]** |
| POST | `/tests/:id/build/upload-url` | 3 | **[novo]** |
| POST | `/tests/:id/build` | 3 | **[novo]** — confirma upload, dispara validação |
| GET | `/tests/:id/build` | 3 | **[novo]** — status da validação |
| DELETE | `/tests/:id/build` | 3 | **[novo]** — substituir build |
| PATCH | `/tests/:id/audience` | 4 | **[novo]** — público, quantidade, duração |
| POST | `/tests/:id/publish` | 5 | **[novo]** — `Idempotency-Key` |
| PATCH | `/tests/:id/status` | pós | **[novo]** — pausar/encerrar |

**Etapa 2 — formulário** *(Tela 07)*

- RN-01: cada pergunta exige tipo e enunciado antes de avançar.
- RN-02: tipos com opções exigem a quantidade mínima de opções do componente.
- RN-03: a ordem das perguntas é persistida **exatamente** como definida
  (campo `position`, reordenação atômica).
- RN-04: `required: true` bloqueia o envio do formulário pelo jogador (validado
  no envio, M8).
- RN-05: exclusão de pergunta com conteúdo preenchido pede confirmação.

**Etapa 3 — build** *(Tela 08)*

- RN-01: só avança com upload **concluído e validado**.
- RN-05: falha de upload, arquivo inválido ou versão incompatível **preservam o
  formulário** e permitem nova tentativa.
- RN-02/03/04 tratam de detecção e configuração do Orbit Plug-in — **deferidas**
  (§10). O gate `requiresTelemetry` já existe no contrato do M4 e é onde essa
  trava se liga quando o plug-in voltar.

**Etapa 4 — público e duração** *(Tela 09)*

- RN-01: precisa existir público elegível configurado antes de finalizar
  (validação server-side de que a combinação retorna estimativa > 0).
- RN-02: faixa etária com mínimo ≤ máximo e dentro dos limites do produto (18+).
- RN-05: publicar só é aceito se todas as etapas anteriores estiverem válidas →
  `422` com a lista de pendências.
- RN-03/04/06 tratam de recálculo de preço, adicionais e cobrança —
  **deferidas** (§10). Mantenha a quantidade de testes e a duração como campos
  próprios: são eles que a precificação vai consumir depois.

**Etapa 5 — conclusão** *(Tela 10)*

- RN-02: recarregar **não pode criar um segundo teste** — `Idempotency-Key` no
  publish, mesmo sem cobrança envolvida. Essa regra não depende de pagamento.
- RN-01/03/04 tratam de confirmação transacional de pagamento e comprovante —
  **deferidas** (§10). Nesta fase a tela confirma apenas a criação e publicação
  do teste.

---

### M6 — Builds

| Método | Rota | Papel | Situação |
| --- | --- | --- | --- |
| GET | `/builds/:id` | studio+ | **[novo]** |
| GET | `/builds/:id/compatibility?platform=&os=&arch=` | autenticado | **[novo]** |
| GET | `/builds/:id/download-url` | player com participação ativa | **[novo]** — presigned, curta duração |

**Regras**

- Upload direto para o storage via presigned PUT; o servidor só recebe a
  confirmação e valida (nunca faz proxy do binário).
- Pipeline de validação (worker): checksum → antivírus → leitura de metadados da
  build → `status: validated | failed` com motivo.
- Download só é liberado com participação ativa **e** compatibilidade de
  dispositivo confirmada (Tela 15 RN-05, Tela 16 RN-03).
- Versionamento: o cliente envia a versão local e o backend responde se precisa
  baixar de novo (Tela 16 RN-05).
- Retomada de download interrompido quando tecnicamente possível — presigned URL
  com suporte a `Range` (Tela 16 RN-04).
- A leitura do manifesto do Orbit Plug-in é um **passo adicional do mesmo
  pipeline**, deferido (§10). Modele o resultado da validação como uma lista de
  etapas, não como um booleano, para que o passo do plug-in entre depois sem
  reescrever o fluxo.

---

### M7 — Feed do jogador e elegibilidade *(Telas 13, 14, 15)*

O jogador não vê uma lista, vê um **feed rankeado no estilo Steam**. O
impulsionamento pago está deferido junto com pagamentos (§10), mas o ranking
precisa nascer com o conceito de **slot** — retrofitar posição paga em um feed
que ordena por data é reescrever o módulo.

| Método | Rota | Papel | Situação |
| --- | --- | --- | --- |
| GET | `/player/home` | player | **[novo]** |
| GET | `/player/feed?section=&cursor=&limit=` | player | **[novo]** — feed rankeado |
| GET | `/player/feed/filters` | player | **[novo]** — facetas (plataforma, gênero, recompensa) |
| GET | `/player/games/:gameId` | player | **[novo]** |
| GET | `/player/games/:gameId/tests` | player | **[novo]** |
| GET | `/player/tests/:testId` | player | **[novo]** |
| GET | `/player/participations?status=` | player | **[novo]** — rota própria; `/player/tests/mine` colidiria com `/player/tests/:testId` |

**Regras do feed**

- **O ranking é calculado no backend.** O cliente recebe a ordem pronta e nunca
  reordena.
- **Paginação de feed rankeado não pode usar o cursor padrão da API.** O cursor
  por UUIDv7 assume ordem cronológica estável; um ranking muda entre as
  requisições e produziria itens repetidos e itens pulados. O feed precisa de
  **cursor com o ranking congelado por sessão de navegação** (`rankingSeed` +
  posição), com validade curta. Essa é uma exceção consciente à convenção de
  paginação do §2.
- Deduplicação: o feed não repete na mesma sessão de navegação o que já foi
  entregue, e reduz a frequência de itens já vistos e ignorados.
- **Modele a composição da página como slots desde já**, ainda que 100% deles
  sejam orgânicos nesta fase. É o ponto de entrada do impulsionamento (§10).
- Sinais do ranking orgânico (a definir, ver §9): compatibilidade do
  dispositivo, gênero/preferência do jogador, recência, vagas restantes, prazo
  próximo do fim, recompensa e taxa de conclusão do teste.

**Regras de elegibilidade**

- Tela 13 RN-01: nível, XP, recompensas e qualidade de feedback vêm **inteiros
  do backend**.
- Tela 13 RN-02: o teste em andamento retorna o **ponto de retomada permitido
  pelo modelo**.
- Tela 13 RN-04 / Tela 14 RN-01: disponibilidade considera status do teste,
  vagas restantes, prazo, requisitos técnicos e elegibilidade do perfil.
- Tela 14 RN-02: **não é permitido iniciar duas participações simultâneas no
  mesmo teste** → `409`.
- Tela 14 RN-03: teste incompatível com o dispositivo vem `disabled: true` +
  `disabledReason` — aparece no feed, mas bloqueado.
- Tela 14 RN-04: valores e prazos exibidos são **os mesmos** usados na
  contratação pelo estúdio.
- Tela 15 RN-01: o CTA é **calculado no backend**:
  `start | continue | completed | in_review | downloading | unavailable`.
- Tela 15 RN-02/03: teste expirado ou sem vaga não inicia; a recompensa pode
  ficar `pending` até a sessão ser validada.
- Tela 13: o bloco de carteira e saque está **deferido** (§10).

---

### M8 — Participações e sessões *(Telas 16 → 19)*

| Método | Rota | Papel | Situação |
| --- | --- | --- | --- |
| POST | `/player/tests/:testId/participations` | player | **[novo]** — `Idempotency-Key` |
| GET | `/participations/:id` | player | **[novo]** |
| POST | `/participations/:id/consents` | player | **[novo]** |
| GET | `/participations/:id/tutorial` | player | **[novo]** |
| POST | `/participations/:id/sessions` | player | **[novo]** |
| PATCH | `/sessions/:id/devices` | player | **[novo]** — mic/webcam on/off |
| POST | `/sessions/:id/heartbeat` | player | **[novo]** |
| POST | `/sessions/:id/finish` | player | **[novo]** — `Idempotency-Key` |
| GET | `/sessions/:id/summary` | player | **[novo]** |
| POST | `/sessions/:id/form-response` | player | **[novo]** — `Idempotency-Key` |
| GET | `/participations/:id/result` | player | **[novo]** |

**Regras**

- Tela 16 RN-01: o tutorial retornado corresponde ao **modelo do teste**.
- Tela 16 RN-02: permissões de gravação/microfone/webcam são solicitadas e
  **registradas antes** da sessão quando obrigatórias.
- Tela 16 RN-03: sessão só inicia após download e **validação** da build.
- Tela 17 RN-01: gravação só começa após consentimento e preparação bem-sucedida.
- Tela 17 RN-03: finalizar a sessão exige confirmação explícita.
- Tela 17 RN-04: mudanças de microfone/webcam são registradas **com timestamp da
  sessão** (`t_ms` relativo ao início).
- Tela 17 RN-05: falha de recurso obrigatório durante a sessão segue a política
  do modelo (encerrar, marcar sessão como inválida ou continuar degradado).
- Tela 18 RN-01: perguntas obrigatórias bloqueiam o envio → `422` por campo.
- Tela 18 RN-02: respostas vinculadas à **sessão correta e ao jogador
  autenticado**.
- Tela 18 RN-03: envio duplicado do mesmo formulário não gera segunda avaliação
  → `409` reproduzindo a resposta original.
- Tela 19 RN-01/02: XP, nota e conquistas são retornados **após a validação da
  sessão**; enquanto não termina → `status: in_review`.
- Tela 19 RN-03: **recarregar não duplica XP nem conquista** — transição de
  estado única e transacional. (A parte de pagamento da regra fica deferida, mas
  o mecanismo idempotente é o mesmo e deve nascer pronto.)
- Tela 19 RN-04 (recompensa financeira no saldo) — **deferida** (§10). Registre
  a recompensa devida na sessão validada mesmo assim: é o dado que a carteira
  vai consumir quando entrar.
- A emissão de **session token do plug-in** faz parte da telemetria, deferida
  (§10). `session_tokens` já existe no schema e permanece dormente.

---

### M9 — Mídia e gravação

| Método | Rota | Papel | Situação |
| --- | --- | --- | --- |
| POST | `/sessions/:id/recordings/upload-url` | player | **[novo]** — multipart/chunked |
| POST | `/sessions/:id/recordings/complete` | player | **[novo]** |
| GET | `/sessions/:id/recordings/:recordingId/playback-url` | studio+ | **[novo]** |

**Regras**

- Pipeline (worker): upload → transcode → thumbnail → gravação reproduzível.
- Tela 12 RN-02: o vídeo usa **`t_ms` desde o início da sessão** como referência
  temporal, a mesma dos eventos de dispositivo. Transcrição, telemetria e
  insights vão se ancorar nessa mesma base quando entrarem — por isso ela
  precisa estar certa agora, não depois.
- Tela 12 RN-03: gravação indisponível **não bloqueia** o restante dos dados da
  sessão — o bloco de mídia vem com `status: unavailable`.
- Retenção de mídia: política de expiração/expurgo configurável (LGPD).
- **Transcrição (ASR) está deferida** (§10) junto com a IA: é uma porta de
  integração stub da mesma natureza. A extração de áudio pode já rodar no
  pipeline, deixando o arquivo pronto para quando o ASR entrar.

---

### M10 — Relatórios *(Telas 11, 12)*

| Método | Rota | Papel | Situação |
| --- | --- | --- | --- |
| GET | `/tests/:id/report` | studio+ | **[novo]** — resumo geral |
| GET | `/tests/:id/report/evolution` | studio+ | **[novo]** |
| GET | `/tests/:id/report/ratings` | studio+ | **[novo]** |
| GET | `/tests/:id/report/testers` | studio+ | **[novo]** — distribuição e arquétipos |
| GET | `/tests/:id/sessions?limit=&cursor=&sort=` | studio+ | **[novo]** |
| GET | `/sessions/:id` | studio+ | **[novo]** — detalhe completo |
| POST | `/sessions/:id/rate` | studio+ | **[novo]** — avaliar/agradecer o tester |
| GET | `/tests/:id/report/export?format=csv\|pdf` | studio+ | **[novo]** |

**Regras**

- Tela 11 RN-01: métricas refletem **somente sessões válidas** do teste atual.
- Tela 11 RN-04: acesso depende de vínculo com o estúdio + permissão.
- Tela 05 RN-02: o botão de relatório reflete o estágio — relatório **parcial**
  quando há dados, **final** só com processamento concluído. O backend expõe
  `reportStage: none | partial | final`.
- Tela 12 RN-01: a sessão exibida pertence ao teste selecionado **e** à
  organização logada.
- Tela 11 RN-02: blocos em processamento retornam `status: processing`.
- **Estrutura o relatório como blocos independentes desde já.** Os blocos de
  telemetria e de insights de IA estão deferidos (§10) e vão entrar como novos
  blocos; se o relatório nascer como um payload monolítico, cada adição vira uma
  quebra de contrato. O handoff já exige tolerância a "relatório sem telemetria"
  e "erro parcial em um módulo" — a mesma estrutura resolve as duas coisas.

---

### M11 — Dashboard do estúdio *(Tela 02)*

| Método | Rota | Papel | Situação |
| --- | --- | --- | --- |
| GET | `/studio/dashboard` | studio+ | **[novo]** |
| GET | `/studio/benchmark` | studio+ | **[novo]** |

**Regras**

- RN-02: **KPIs são calculados e consolidados no backend.** A UI não recalcula
  valores financeiros nem métricas críticas.
- RN-03: status de jogos e testes vêm do estado retornado pelo backend.
- Cache em Redis com invalidação por evento (nova sessão validada, novo teste,
  novo pagamento).

> **Pendência:** a fonte de dados do "benchmark de mercado" não está definida no
> handoff (dado interno agregado × fonte externa).

---

### M12 — Gamificação: XP, nível, conquistas, missões, ranking *(Telas 13, 19)*

| Método | Rota | Papel | Situação |
| --- | --- | --- | --- |
| GET | `/player/progress` | player | **[novo]** |
| GET | `/player/achievements` | player | **[novo]** |
| GET | `/player/missions` | player | **[novo]** |
| GET | `/rankings?scope=&period=` | player | **[novo]** |

**Regras**

- O motor de XP/conquistas roda **após a validação da sessão**, de forma
  transacional e idempotente (ledger `xp_events` append-only, com chave única
  por origem).
- "Qualidade de feedback" é uma nota calculada no servidor a partir da avaliação
  do estúdio + completude/consistência das respostas.
- A recompensa **financeira** da sessão está deferida (§10); XP, nível,
  conquistas e ranking não dependem dela e seguem nesta fase.

---

### M13 — Comunidade e avaliações do jogo *(Tela 15)*

| Método | Rota | Papel | Situação |
| --- | --- | --- | --- |
| GET | `/games/:id/community/posts` | autenticado | **[novo]** |
| POST | `/games/:id/community/posts` | player | **[novo]** |
| POST | `/community/posts/:id/report` | autenticado | **[novo]** |
| PATCH | `/community/posts/:id/moderate` | studio+ | **[novo]** |
| GET | `/games/:id/reviews` | autenticado | **[novo]** |
| POST | `/games/:id/reviews` | player | **[novo]** |

**Regra** — Tela 15 RN-04: comunidade respeita regras de moderação e vínculo com
o jogo.

---

### M14 — Notificações

- E-mails transacionais via `NotificationPort`: convite de membro, redefinição
  de senha, teste publicado, sessão validada, recompensa liberada, saque
  processado, build reprovada.
| Método | Rota | Papel | Situação |
| --- | --- | --- | --- |
| GET | `/notifications?unreadOnly=` | autenticado | **[novo]** |
| PATCH | `/notifications/:id/read` | autenticado | **[novo]** |

- Notificações in-app dependem de confirmação no Figma de que o componente
  existe (pendência 8).

---

### M15 — Saúde e observabilidade

| Método | Rota | Papel | Situação |
| --- | --- | --- | --- |
| GET | `/health` | público | [✓] — já verifica Postgres, Redis e storage; responde `503` quando algum cai |
| GET | `/health/ready` | público | **[novo]** — readiness que inclui a fila (BullMQ) |

- Separar liveness de readiness: uma instância que não consegue enfileirar job
  não deve receber tráfego, mas também não deve ser reiniciada por isso.
- `requestId` já propagado no envelope de erro e nos logs (pino).
- Métricas de fila e de latência dos jobs.

---

## 4. Integrações externas

### Nesta fase

| # | Integração | Porta / uso | Situação |
| --- | --- | --- | --- |
| 1 | **Object storage** — MinIO (protocolo S3) | `StoragePort` — builds, mídia, assets | ✓ real |
| 2 | **E-mail transacional** — SMTP/Mailhog em dev | `NotificationPort` | ✓ dev; provider de produção a definir |
| 3 | **Redis / BullMQ** | filas e idempotência | ✓ real |
| 4 | **Scan de malware da build** — ClamAV ou serviço | worker de validação | **[novo]** |
| 5 | **Transcode de vídeo** — ffmpeg | worker de mídia | **[novo]** |
| 6 | **CDN** para builds e mídia | opcional, reduz custo de egress | a definir |

### Deferidas (§10)

Gateway de pagamento, provedor de repasse/saque, KYC, ASR (Whisper ou
gerenciado), LLM para insights (Claude API) e o SDK do Orbit Plug-in. As portas
`PaymentPort`, `AsrPort` e `AiPort` já existem com adaptadores falsos e
permanecem assim — **nenhuma delas deve ganhar implementação real nesta fase**.

## 5. Modelo de dados

Detalhamento completo — colunas, chaves, índices, constraints e ordem de
migração — em [`DATA-MODEL.md`](./DATA-MODEL.md). Resumo:

**A criar:** `tests`, `test_audience_criteria`, `test_form_questions`,
`test_form_options`, `builds`, `build_validation_steps`, `participations`,
`session_consents`, `sessions`, `session_device_events`, `session_recordings`,
`session_validations`, `form_responses`, `form_answers`,
`feed_ranking_snapshots`, `player_preferences`, `xp_events`, `achievements`,
`player_achievements`, `missions`, `player_missions`, `ranking_snapshots`,
`test_report_snapshots`, `game_reviews`, `community_posts`,
`community_reports`, `notifications`, `password_reset_tokens`,
`idempotency_keys`.

**Dívida a quitar junto com `builds`:** a FK
`plugin_manifests.build_id → builds.id`, registrada em `DECISIONS.md` §1.3.

**Não criar agora** (deferidas, §10): `payment_intents`, `payments`,
`invoices`, `wallets`, `wallet_transactions`, `withdrawals`, `boost_packages`,
`test_boosts`, `feed_events`, `insights`, `transcripts`, `price_tables`.

Fluxo obrigatório de migração (`AGENTS.md`): editar schema `.ts` →
`pnpm db:generate` → revisar SQL → `pnpm db:migrate`. `drizzle/manual/` só para
o que o Drizzle não expressa (particionamento, triggers).

## 6. Jobs assíncronos (BullMQ)

| Job | Dispara | Produz |
| --- | --- | --- |
| `build.validate` | confirmação de upload | checksum, scan, status da build |
| `media.transcode` | gravação completa | vídeo reproduzível + thumbnail |
| `media.extract-audio` | gravação completa | áudio pronto para o ASR entrar depois |
| `session.validate` | sessão finalizada | sessão válida/inválida → libera XP e conquistas |
| `report.aggregate` | sessão validada | `test_report_snapshots` |
| `dashboard.kpi.refresh` | eventos de domínio | cache de KPIs |
| `feed.rank.refresh` | agendado + eventos | ranking orgânico pré-calculado |
| `notifications.send` | eventos de domínio | e-mail |

**Deferidos (§10):** `plugin.manifest.parse`, `asr.transcribe`,
`ai.insight.session`, `ai.insight.test`, `payment.reconcile`, `wallet.payout`,
`boost.deliver`, `boost.expire`, `feed.events.rollup`, `telemetry.rollup`,
`telemetry.partition.maintain`.

## 7. Regras críticas — checklist de aceite

1. Nenhuma query cruza organização (tenancy no repositório, não no serviço).
2. Papel sempre vindo do token, nunca do corpo da requisição.
3. Publicação de teste, participação, envio de formulário e finalização de
   sessão são idempotentes — repetir não duplica teste, XP nem conquista.
4. Recurso em processamento devolve `status`, nunca valor provisório disfarçado.
5. Bloco quebrado não derruba a tela — falha parcial é modelada.
6. Gravação só após consentimento registrado.
7. O feed é ordenado pelo backend, com cursor de ranking congelado — nunca o
   cursor cronológico padrão.
8. Elegibilidade, vagas, prazo e compatibilidade são verificados no servidor
   antes de qualquer início de participação.
9. Vídeo e eventos da sessão compartilham a mesma base temporal (`t_ms`).
10. Ações críticas geram auditoria.
11. Último Owner ativo não pode ser removido nem rebaixado.
12. Senha nunca é retornada, exibida ou logada.
13. Desativação lógica quando há histórico associado.

## 8. Ordem sugerida de entrega

| Fase | Escopo |
| --- | --- |
| **F1 — Fundação** | Signup estúdio/jogador, reset de senha, central de usuários e membros, jogos + upload de assets, auditoria exposta |
| **F2 — Contratação** | Catálogo de modelos, wizard completo (rascunho, formulário, build, público) e publicação do teste |
| **F3 — Execução** | Feed do jogador e elegibilidade, participação, tutorial e download da build, sessão, envio de formulário |
| **F4 — Resultados** | Mídia e gravação, validação de sessão, XP/conquistas, relatórios, dashboard do estúdio |
| **F5 — Complementos** | Comunidade e avaliações, missões e ranking, notificações in-app, exportações |

Ao final da F5 a plataforma fecha o ciclo completo sem dinheiro envolvido: o
estúdio cria e publica um teste, o jogador encontra no feed, baixa, joga,
responde e recebe XP; o estúdio lê o relatório. É esse ciclo que valida o
produto antes de acoplar o trilho financeiro.

## 9. Pendências e decisões em aberto

Só o que bloqueia **esta** fase. As decisões de pagamento, impulsionamento e IA
voltam junto com o escopo deferido (§10).

| # | Pendência | Impacto |
| --- | --- | --- |
| 1 | Frames de "Novo jogo" (Tela 04) e "Central de usuários" (Tela 20) marcados como pendentes no handoff | Campos exatos, obrigatoriedade e limites indefinidos — bloqueia F1 |
| 2 | **Sinais e pesos do ranking orgânico do feed** | Sem isso o feed vira ordenação por data — bloqueia F3 |
| 3 | **Critérios de validação/invalidação de sessão** (antifraude, qualidade mínima) | É o gatilho de XP e conquistas — bloqueia F4 |
| 4 | **Fórmulas de XP, de nível e de "qualidade de feedback"** | Bloqueia F4 |
| 5 | Escopo e periodicidade do ranking de jogadores | Afeta F5 |
| 6 | Política de retenção de vídeo e prazo de expurgo | LGPD e custo de storage — decidir antes da F4 |
| 7 | Fonte de dados do benchmark de mercado (Tela 02) | Afeta o dashboard na F4 |
| 8 | Existência de notificações in-app no Figma | Afeta F5 |
| 9 | Como a recompensa aparece na UI enquanto não há carteira (valor informativo × ocultar) | Afeta Telas 13, 14, 15 e 19 |

## 10. Deferido — fora do escopo desta fase

Cortado por decisão de escopo para focar na plataforma. **Nada aqui foi
descartado**: o mapeamento fica registrado para quando voltar, e os pontos de
acoplamento estão marcados nos módulos ativos para que a volta não exija
reescrita.

**O que sai:** trilho financeiro (cobrança do estúdio e carteira/saque do
jogador), impulsionamento do feed, Orbit Plug-in e ingestão de telemetria,
insights de IA e transcrição por ASR.

**O que fica preparado nos módulos ativos**

| Ponto de acoplamento | Onde | Por quê |
| --- | --- | --- |
| `requiresTelemetry` no contrato do modelo de teste | M4 | É o gate que a Etapa 3 usa quando o plug-in voltar |
| Validação de build como **lista de etapas**, não booleano | M6 | O passo de manifesto do plug-in entra como mais uma etapa |
| Composição do feed em **slots** | M7 | Slot pago entra sem reordenar o módulo |
| `t_ms` desde o início da sessão como base temporal única | M8, M9 | Telemetria, transcrição e insights se ancoram nela |
| Recompensa devida registrada na sessão validada | M8 | É o dado que a carteira consome quando entrar |
| Relatório em **blocos independentes** com `status` | M10 | Telemetria e IA entram como blocos novos, sem quebrar contrato |
| Idempotência no publish do teste | M5 | A regra não depende de cobrança e já nasce correta |
| `session_tokens`, `plugin_manifests`, `trigger_definitions`, `heatmap_cells`, `telemetry_events` | schema | Tabelas já existem e ficam dormentes |

---

### Deferido — Pagamentos do estúdio *(Telas 09, 10)*

Direção do dinheiro (já decidida em `DECISIONS.md` §1.2): **estúdio paga, tester
recebe**.

| Método | Rota | Papel | Situação |
| --- | --- | --- | --- |
| GET | `/payments/:id` | studio+ | **[novo]** |
| GET | `/orgs/current/invoices` | owner/admin | **[novo]** |
| POST | `/webhooks/payments/:provider` | público (assinatura) | **[novo]** |

**Regras**

- `PaymentPort` real substitui o `FakePaymentAdapter`.
- Webhook: assinatura verificada, processamento **idempotente** por
  `provider_event_id`, tolerante a reentrega e fora de ordem.
- Estados tratados: `approved`, `declined`, `pending`, `expired`, `duplicated`
  (Tela 09, estados e validações).
- Transição para "teste publicado" acontece **na confirmação do pagamento**,
  nunca no retorno da tela.
---

### Deferido — Carteira e saque do jogador *(Tela 13)*

| Método | Rota | Papel | Situação |
| --- | --- | --- | --- |
| GET | `/player/wallet` | player | **[novo]** — saldo disponível e pendente |
| GET | `/player/wallet/transactions` | player | **[novo]** |
| GET | `/player/wallet/eligibility` | player | **[novo]** |
| POST | `/player/wallet/withdrawals` | player | **[novo]** — `Idempotency-Key` |
| GET | `/player/wallet/withdrawals/:id` | player | **[novo]** |

**Regras**

- Tela 13 RN-03: **o backend decide a elegibilidade do saque**; o front apenas
  reflete habilitado/desabilitado com motivo.
- Tela 19 RN-04: recompensa entra em `pending` e só migra para `available` após
  a validação da sessão.
- Ledger contábil append-only — saldo é derivado das transações, nunca um campo
  editável.
- Saque exige dados de recebimento válidos e passa por aprovação/liquidação
  assíncrona.
---

### Deferido — Impulsionamento do feed *(Telas 09, 14)*

Slot pago no topo do feed do jogador, contratado na Etapa 4 do wizard ou avulso.
Depende de pagamento, então sai junto.

| Método | Rota | Papel |
| --- | --- | --- |
| GET | `/boosts/packages` | studio+ |
| POST | `/tests/:id/boost` | studio+ |
| GET | `/tests/:id/boost` | studio+ |
| PATCH | `/tests/:id/boost` | studio+ |
| GET | `/tests/:id/boost/metrics` | studio+ |
| POST | `/player/feed/events` | player |

**Regras que não podem se perder**

- **Impulsionar não desliga elegibilidade.** Teste impulsionado que o jogador não
  pode fazer não ocupa slot pago — cai para o orgânico como `disabled` com
  motivo. Pagar compra posição, nunca a suspensão das regras das Telas 14 e 15.
- **Todo item pago vem marcado** (`promoted: true`). Publicidade não
  identificada é questão regulatória.
- Boost **suspenso automaticamente** quando o teste esgota vagas, expira ou é
  encerrado.
- Impressão e clique chegam de origem não confiável e sustentam a cobrança:
  exigem deduplicação por `(jogador, item, janela)`, rate limit e descarte de
  sessão suspeita.
- Com mais boosts ativos que slots, a seleção é **ponderada e rotativa**.

---

### Deferido — Telemetria e Orbit Plug-in

| Método | Rota | Autenticação | Situação |
| --- | --- | --- | --- |
| POST | `/telemetry/events` | session token do plug-in | **[novo]** |
| POST | `/telemetry/heatmap` | session token do plug-in | **[novo]** |
| GET | `/sessions/:id/telemetry` | studio+ | **[novo]** |
| GET | `/tests/:id/telemetry/summary` | studio+ | **[novo]** |

**Regras**

- Autenticação por **session token de curta duração** (`session_tokens`, tabela
  já existente) — não pelo JWT do usuário.
- Envio em lote; **upsert por `(session_id, event_id)`** para que reenvio não
  infle métricas (contrato já previsto em `TelemetryStorePort`).
- Tipos de gatilho **congelados**: `counter`, `timer`, `ui_event`, `vector`,
  `input`. Alterar quebra builds já publicadas.
- Heatmap agrega em `heatmap_cells` por `(session_id, x, y, z)` com incremento.
- Eventos recebidos após o fim da sessão + tolerância são descartados.
- Rate limit e limite de payload próprios (volume alto, cliente não confiável).
- Manutenção de partições diárias de `telemetry_events` via job agendado.
---

### Deferido — IA e insights *(Telas 11, 12)*

| Método | Rota | Papel | Situação |
| --- | --- | --- | --- |
| GET | `/tests/:id/insights?q=&type=` | studio+ | **[novo]** |
| GET | `/sessions/:id/insights` | studio+ | **[novo]** |

**Regras**

- Geração assíncrona via `AiPort` (worker), por sessão e consolidada por teste.
- Tela 11 RN-03 / Tela 12 RN-04: cada insight mantém **vínculo com a sessão e a
  evidência de origem** (`sessionId`, `tMs`, `sourceType`) e é marcado como
  gerado por IA (`generatedByAi: true`). Insight **não substitui** o dado bruto.
- Tela 11 RN-02: enquanto processa, retorna `status: processing`.
- Busca/filtro server-side (a tela tem campo de busca sobre os cards).
---

### Deferido — Transcrição (ASR)

`AsrPort` com adaptador stub. Pipeline previsto: áudio extraído da gravação →
transcrição com timestamps ancorados em `t_ms` → `transcripts`. Alimenta a
prévia da Tela 18 e a navegação por transcrição da Tela 12.

Tela 12 RN-02 continua valendo quando entrar: a transcrição usa a **mesma
referência temporal** do vídeo e dos eventos da sessão.
