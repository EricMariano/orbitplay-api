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
