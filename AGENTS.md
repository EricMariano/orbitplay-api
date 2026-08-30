# AGENTS.md

Instruções para agentes de IA (Cursor, Claude Code, etc.) que trabalham neste
repositório. Leia isto **antes** de editar código. Para contexto de produto e
setup humano, veja `README.md`; para decisões bloqueantes e desvios, `DECISIONS.md`.

---

## O que é este repositório

- **OrbitPlay API** — backend NestJS + Drizzle + Postgres.
- Repositório **exclusivo da API**. O front (`orbitplay-web`) consome
  `openapi.json` versionado na raiz.
- Stack: NestJS 12, Drizzle ORM, Zod (`nestjs-zod`), Vitest, BullMQ, Redis,
  MinIO (S3), Mailhog (dev).
- Node alvo: **22 LTS** (`.nvmrc`, `engines`). Use `nvm use` / `fnm use`.

---

## Regras gerais para agentes

1. **Escopo mínimo** — altere só o necessário para a tarefa. Não refatore código
   adjacente “de brinde”.
2. **Siga os padrões existentes** — copie o módulo `games` como molde para novas
   fatias verticais.
3. **Não commite** a menos que o usuário peça explicitamente.
4. **Não edite `.env`** — só `.env.example` quando adicionar variáveis novas.
5. **Não crie documentação extra** (README, DECISIONS, AGENTS) sem pedido —
   exceto quando a tarefa for justamente documentar.
6. **Valide antes de encerrar** — rode lint, typecheck e testes relevantes.
7. **Decisões de produto** — se algo contradizer `DECISIONS.md`, pare e pergunte;
   não “decida sozinho” em pontos bloqueantes (tenancy, pagamento, A/B, idade).

---

## Banco de dados e migrações

### Fonte da verdade

O schema TypeScript em `src/infra/database/schema/` é a **única fonte da
verdade**. Tudo em `drizzle/` é **gerado** ou **exceção manual documentada**.

### Fluxo obrigatório para mudanças de schema

```
edita schema .ts
  → pnpm db:generate
  → revisa o SQL gerado em drizzle/
  → pnpm db:migrate
  → commita schema + migração gerada juntos (quando o usuário pedir commit)
```

### O que NUNCA fazer

| Proibido | Motivo |
| -------- | ------ |
| Escrever ou editar arquivos em `drizzle/*.sql` (gerados) | Quebra o histórico do Drizzle e diverge do schema TS |
| Criar migração SQL “na mão” no lugar de `db:generate` | O journal (`drizzle/meta/`) fica inconsistente |
| Alterar `drizzle/meta/` manualmente | Metadados do Drizzle Kit — só o kit escreve |
| Colocar DDL de tabela normal em `drizzle/manual/` | Manual é só para o que o Drizzle **não expressa** |

### Exceção: `drizzle/manual/`

Use **somente** para DDL que o Drizzle não suporta:

- particionamento (`PARTITION BY RANGE`, etc.)
- triggers, extensões Postgres, backfills pontuais

Regras:

- Arquivo nomeado em ordem: `0002_descricao.sql`, `0003_...sql`
- Aplicado pelo mesmo runner (`pnpm db:migrate`), **depois** das migrações geradas
- Rastreado em `__manual_migrations` (não edite essa tabela)
- Exemplo existente: `0001_telemetry_events_partitioned.sql` — `telemetry_events`
  **não** está no schema Drizzle; o adaptador usa SQL cru

### IDs e tenancy

- IDs: **UUID v7** gerados na aplicação (`src/shared/util/uuid.ts`), nunca
  `serial`/`autoincrement` para entidades de domínio.
- Toda tabela de domínio org-scoped tem `organization_id`.
- Timestamps: `createdAt` + `updatedAt` onde fizer sentido.
- Relações Drizzle: defina **os dois lados** com `@relation` (ou equivalente
  Drizzle) e índices em campos consultados com frequência.

### Scripts de banco

| Script | Uso |
| ------ | --- |
| `pnpm db:generate` | Gera migração a partir do schema TS |
| `pnpm db:migrate` | Aplica geradas + manual |
| `pnpm db:seed` | Seed determinístico e idempotente |
| `pnpm db:reset` | Dev only — dropa schemas, re-migra (não faz seed) |

Após `db:reset`, rode `pnpm db:seed` se precisar de dados.

---

## Arquitetura e camadas

### Estrutura de pastas

```
src/
├─ config/          env.schema (Zod) + configuration
├─ shared/          guards, filters, interceptors, ports, util — sem lógica de domínio
├─ infra/           adaptadores concretos (DB, Redis, MinIO, mail, queue, fakes)
├─ modules/       fatias verticais (health, iam, orgs, games, audit, …)
└─ workers/       processos BullMQ separados da API
```

### Módulo de feature (copie `games`)

Cada módulo em `src/modules/<nome>/`:

```
dto/              schemas Zod + createZodDto
*.controller.ts   rotas HTTP, decorators (@Roles, @CurrentUser)
*.service.ts      regras de negócio
*.repository.ts   acesso a dados (estende OrgScopedRepository se org-scoped)
*.module.ts       wiring
*.spec.ts         testes de unidade
```

**Regra de importação entre módulos:** um módulo importa o **service** de outro,
**nunca** o repository diretamente.

### Ports & adapters

Interfaces em `src/shared/ports/`. Implementações em `src/infra/`.

| Porta | Adaptador atual |
| ----- | --------------- |
| `StoragePort` | MinIO (`STORAGE_*`, não `S3_*`) |
| `NotificationPort` | Mailhog |
| `TelemetryStorePort` | Postgres (SQL cru) |
| `PaymentPort` | `FakePaymentAdapter` |
| `AiPort` / `AsrPort` | stubs |

Injete pela **porta** nos services; não acople módulos de domínio ao SDK concreto.

### Tenancy (RN-01) — crítico

- Filtro de `organization_id` vive em `OrgScopedRepository`
  (`src/infra/database/base.repository.ts`), **não** nos services.
- Repositórios org-scoped **estendem** `OrgScopedRepository` e roteiam leituras/
  escritas pelos métodos base (`findByIdInOrg`, `getByIdInOrgOrThrow`, etc.).
- Recurso de **outra organização** → **404** (`NOT_FOUND`), **nunca 403**.
- ID malformado → **404**, nunca 500.

### Auth e autorização

- Access token JWT curto no corpo; refresh em cookie `httpOnly`.
- Papel vem do **token** (membership ativa), nunca do corpo da requisição (RN-03).
- Login: mensagem genérica + tempo comparável (RN-02) — não vazar se e-mail existe.
- Guards globais em `app.module.ts`: `JwtAuthGuard` → `RolesGuard`.
- Rotas públicas: decorator `@Public()`.

---

## API, DTOs e OpenAPI

### Uma definição, dois usos

DTOs são **Zod** + `createZodDto` (`nestjs-zod`):

- validação em runtime (`ZodValidationPipe` global)
- schema OpenAPI gerado automaticamente

**Não** duplique tipos à mão para o front — o contrato é `openapi.json`.

### Após mudar rotas ou DTOs

```bash
pnpm openapi:generate   # nest build && node dist/openapi.js
```

Versione `openapi.json` no PR. O front regenera tipos a partir dele.

### Envelope de erro

Montado **somente** por `HttpExceptionFilter`. Use `AppException` para erros de
domínio com código estável:

```json
{
  "statusCode": 422,
  "code": "VALIDATION_ERROR",
  "message": "Dados inválidos",
  "fieldErrors": { "title": "Título obrigatório" },
  "requestId": "01a0..."
}
```

Não monte envelopes de erro ad hoc nos controllers.

### Outras convenções HTTP

- **Paginação:** cursor — `?limit=&cursor=` → `{ data, nextCursor }`
- **Idempotência:** header `Idempotency-Key` em mutações (Redis, 24h TTL)
- **Auditoria:** `AuditInterceptor` — persiste **antes** de responder
- **Rate limit:** IP (Throttler) + identificador (Redis) em `/auth/login` e
  recuperação de senha

---

## Variáveis de ambiente

- Schema: `src/config/env.schema.ts` (Zod, falha no boot).
- Novas variáveis: adicione em `env.schema.ts` **e** `.env.example` com comentário.
- Toda variável é **obrigatória** — remover uma linha do `.env` deve falhar no
  boot apontando o nome (critério #11).
- Valores em `.env.example` são descartáveis de dev; nunca use em produção.

---

## Testes

### Unidade

- Arquivos: `src/**/*.spec.ts`
- Runner: `pnpm test` (Vitest)
- Teste comportamento real; evite asserts triviais.

### E2E

- Arquivos: `test/**/*.e2e-spec.ts`
- Runner: `pnpm test:e2e` — requer Docker (Postgres, Redis, MinIO)
- Banco: `orbitplay_test`, migrado e semeado no `globalSetup`
- Use helpers em `test/helpers/` (`createE2EApp`, `test-db`)
- Credenciais seed: ver `README.md` (`Orbit@Demo123`)

### Quando adicionar testes

| Mudança | Teste esperado |
| ------- | -------------- |
| Regra de negócio nova | unit spec no service |
| Endpoint ou fluxo HTTP | e2e spec |
| Isolamento org / RBAC | e2e (padrão em `games.e2e-spec.ts`) |
| Validação de env | `env.schema.spec.ts` |

---

## Qualidade e tooling

### Comandos de verificação

```bash
pnpm lint          # ESLint — só src/ e test/ (type-aware)
pnpm typecheck     # tsc --noEmit
pnpm test          # unit
pnpm test:e2e      # e2e (Docker up)
pnpm build         # nest build
pnpm openapi:generate
```

### ESLint e lint-staged

- ESLint type-aware roda em `{src,test}/**/*.ts` — **não** em configs da raiz
  (`eslint.config.mjs`, `drizzle.config.ts`, etc.).
- `.lintstagedrc.json` reflete isso: ESLint só em `src`/`test`; Prettier nos
  demais `*.{ts,mjs}`.

### Commits (quando o usuário pedir)

- Conventional Commits (`commitlint.config.mjs`)
- **Nunca** commite `.env`, segredos ou credenciais reais
- Schema + migração gerada **no mesmo commit**

---

## Checklist antes de dar a tarefa por concluída

- [ ] Mudança de schema passou por `db:generate` (não SQL manual em `drizzle/`)
- [ ] `pnpm db:migrate` aplicou sem erro (se houve schema)
- [ ] `pnpm openapi:generate` rodou (se houve mudança de contrato)
- [ ] `pnpm lint && pnpm typecheck` passam
- [ ] Testes relevantes passam (`test` e/ou `test:e2e`)
- [ ] Tenancy respeitada (404 cross-org, filtro no repository)
- [ ] Sem imports de repository entre módulos
- [ ] `.env.example` atualizado (se nova env var)
- [ ] Escopo mínimo — sem refactors não solicitados

---

## Referências rápidas

| Arquivo | Conteúdo |
| ------- | -------- |
| `README.md` | Setup, scripts, credenciais seed |
| `DECISIONS.md` | Decisões bloqueantes (org, pagamento, A/B, idade) |
| `src/modules/games/` | Molde de fatia vertical completa |
| `src/infra/database/base.repository.ts` | Tenancy e paginação cursor |
| `src/app.module.ts` | Guards, pipes e interceptors globais |
| `test/games.e2e-spec.ts` | Padrões de teste e2e (critérios #3–#8) |
