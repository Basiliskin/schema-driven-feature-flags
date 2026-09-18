Да. Я бы зафиксировал проект именно так: **не пытаться сделать полноценный LaunchDarkly/PostHog-клон**, а сделать лёгкий **AWS-native Feature Flag + Configuration Runtime**.

# Проект: FeatureSync

**Рабочее название:** `FeatureSync`

### Основная идея

> **Feature flags и typed configuration, которые хранятся в S3, распространяются через SNS, вычисляются локально и полностью управляются через простой UI/CLI.**

Приложение практически не зависит от AWS во время runtime.

```text
                         ┌──────────────────────┐
                         │    FeatureSync UI    │
                         │                      │
                         │ flags / config       │
                         │ validation            │
                         │ versions / rollback  │
                         └──────────┬───────────┘
                                    │
                              AWS SDK / IAM
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │         S3           │
                         │                      │
                         │ immutable snapshots  │
                         └──────────┬───────────┘
                                    │
                              S3 notification
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │       Lambda         │
                         │ validate / publish   │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │        SNS           │
                         └──────────┬───────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
                 App #1          App #2          App #N
                    │               │               │
              local memory    local memory    local memory
```

> В текущей реализации уведомление в SNS отправляет CLI-publisher после замены `current.json`, а не S3 event → Lambda. Контракт сообщения — [docs/spec/change-notification.md](spec/change-notification.md).

---

# 1. Главные принципы

## 1.1 Local-first

В runtime:

```typescript
flags.get("payment-flow");
```

не должен делать:

- HTTP request
- S3 request
- Redis request
- database query

Это обычный lookup в памяти.

---

## 1.2 S3 — Source of Truth

S3 содержит immutable snapshots.

```text
production/
    snapshots/
        41.json
        42.json
        43.json

    current.json
```

Приложение всегда может определить:

```text
current version = 43
```

---

## 1.3 SNS — notification, а не storage

SNS сообщает:

```json
{
  "environment": "production",
  "version": 43,
  "snapshotKey": "production/snapshots/43.json"
}
```

Но если приложение пропустило событие — это не проблема.

При следующем запуске оно снова получает snapshot из S3.

---

## 1.4 Lambda — controlled publisher

Lambda отвечает за:

- validation;
- создание версии;
- запись snapshot;
- публикацию SNS;
- audit metadata.

---

# 2. Что именно является Feature

FeatureSync должен поддерживать не только:

```typescript
boolean;
```

но и configuration.

### Boolean

```json
{
  "new-dashboard": {
    "type": "boolean",
    "enabled": true
  }
}
```

### Configuration

```json
{
  "payment-flow": {
    "type": "config",
    "enabled": true,
    "config": {
      "provider": "stripe",
      "maxAmount": 5000,
      "require3ds": true
    }
  }
}
```

---

# 3. User Context / Rules

Флаг может зависеть от attributes.

Например:

```text
country = IL
plan = enterprise
platform = ios
```

Configuration:

```json
{
  "payment-flow": {
    "default": {
      "provider": "stripe",
      "maxAmount": 1000
    },

    "rules": [
      {
        "when": {
          "plan": "enterprise"
        },
        "value": {
          "provider": "stripe",
          "maxAmount": 10000
        }
      }
    ]
  }
}
```

Runtime:

```typescript
const config = flags.evaluate("payment-flow", {
  plan: user.plan,
  country: user.country,
});
```

Всё вычисляется локально.

---

# 4. Typed Schema

Это одна из ключевых функций проекта.

Разработчик должен определить schema:

```typescript
const paymentFlow = defineFeature({
  key: "payment-flow",

  schema: z.object({
    provider: z.enum(["stripe", "adyen"]),
    maxAmount: z.number(),
    require3ds: z.boolean(),
  }),

  default: {
    provider: "stripe",
    maxAmount: 1000,
    require3ds: true,
  },
});
```

Используем **Zod** для runtime validation.

Это позволяет:

- валидировать configuration;
- генерировать UI;
- валидировать snapshot;
- проверять изменения;
- получать TypeScript types.

---

# 5. TypeScript API

Основной API:

```typescript
flags.isEnabled("new-dashboard");

flags.get("payment-flow");

flags.evaluate("payment-flow", {
  plan: "enterprise",
});
```

Дополнительно:

```typescript
flags.version();

flags.has("payment-flow");

flags.getAll();

flags.ready();
```

---

# 6. NestJS Module

Отдельный package:

```text
@featuresync/nestjs
```

Использование:

```typescript
@Module({
  imports: [
    FeatureSyncModule.forRoot({
      environment: process.env.NODE_ENV,
    }),
  ],
})
export class AppModule {}
```

И DI:

```typescript
constructor(
  private readonly flags: FeatureFlags,
) {}
```

---

# 7. NestJS Decorators

### `@FeatureFlag`

```typescript
@FeatureFlag('new-payment-flow')
async createPayment() {
}
```

### `@FeatureGuard`

Опциональный guard:

```typescript
@Feature('new-dashboard')
@UseGuards(FeatureFlagGuard)
@Get('/dashboard')
getDashboard() {}
```

Но decorators не должны быть обязательными.

Основной API должен оставаться обычным:

```typescript
flags.isEnabled(...)
```

Это сохраняет библиотеку простой и предсказуемой.

---

# 8. Local Development

Не заставлять developer использовать AWS.

```env
FEATURESYNC_FILE=./feature-flags.json
```

Тогда:

```text
development
     ↓
local JSON
     ↓
FeatureSync
```

Production:

```env
FEATURESYNC_BUCKET=my-company-flags
FEATURESYNC_KEY=production/current.json
```

```text
production
     ↓
S3
     ↓
FeatureSync
```

Один и тот же application code.

---

# 9. Environment

Поддержать:

```text
development
staging
production
```

Но архитектура должна позволять:

```text
preview/pr-123
customer-a
tenant-x
```

в будущем.

Для MVP достаточно стандартных environments.

---

# 10. AWS Infrastructure

FeatureSync CLI должен уметь создавать инфраструктуру.

```bash
npx featuresync init
```

UI/CLI определяет:

```text
AWS account
Region
Environment
Project name
```

И создаёт:

### S3

```text
featuresync-{project}
```

### SNS

```text
featuresync-{project}-updates
```

### Lambda

```text
featuresync-{project}-publisher
```

### IAM

Отдельные роли:

```text
ApplicationReadRole
PublisherRole
AdminRole
```

---

# 11. Очень важная безопасность

Application:

```text
S3 GetObject
```

Только read.

Application **не имеет права**:

```text
PutObject
DeleteObject
Publish
```

Publisher:

```text
S3 write
SNS publish
```

Admin:

```text
publish configuration
rollback
manage flags
```

Это позволяет избежать ситуации, когда production application случайно или намеренно изменяет production flags.

---

# 12. UI

UI должен быть **маленьким**, а не пытаться стать enterprise-platform.

### Dashboard

```text
Feature Flags

Environment: production

┌────────────────────┬─────────┬─────────┐
│ Feature            │ Status  │ Version │
├────────────────────┼─────────┼─────────┤
│ new-payment-flow   │ ON      │ 43      │
│ new-dashboard      │ OFF     │ 43      │
│ new-checkout       │ ON      │ 42      │
└────────────────────┴─────────┴─────────┘
```

---

# 13. Dynamic Configuration UI

Если schema:

```typescript
z.object({
  provider: z.enum(["stripe", "adyen"]),
  maxAmount: z.number(),
  require3ds: z.boolean(),
});
```

UI автоматически показывает:

```text
Payment Flow

Enabled
[ ✓ ]

Provider
[ Stripe ▼ ]

Max amount
[ 5000 ]

Require 3DS
[ ✓ ]
```

То есть UI не должен содержать hardcoded business configuration.

**Schema → UI.**

---

# 14. Rules UI

Например:

```text
Rules

IF

    plan     equals     enterprise

THEN

    maxAmount = 10000
    provider  = stripe

[ + Add rule ]
```

Позже:

```text
country IN [IL, US]
platform = ios
percentage = 20%
```

Но **percentage rollout я бы не включал в самый первый MVP**, потому что он сильно усложняет evaluation semantics.

---

# 15. Versioning

Каждая публикация создаёт новую версию:

```text
v41
v42
v43
v44
```

Нельзя мутировать старый snapshot.

---

# 16. Preview перед публикацией

UI:

```text
Changes

payment-flow.maxAmount
1000 → 5000

payment-flow.require3ds
false → true

new-dashboard
false → true
```

Кнопки:

```text
Cancel
Publish v44
```

---

# 17. Rollback

```text
Version History

v44   current
v43
v42
v41
```

Нажимаем:

```text
Rollback to v43
```

Но технически не мутируем `v43`.

Создаём:

```text
v45 → same content as v43
```

Это сохраняет audit trail.

---

# 18. CI/CD

CLI:

```bash
featuresync snapshot
```

Получает:

```text
production → v43
```

И сохраняет:

```text
featuresync.snapshot.json
```

Pipeline:

```text
             snapshot v43
                   │
        ┌──────────┼──────────┐
        ▼          ▼          ▼
      test 1     test 2     test 3
```

Все используют одинаковую configuration.

Это даёт:

- reproducible tests;
- меньше AWS/provider requests;
- независимость от внешнего сервиса;
- возможность offline CI.

---

# 19. Snapshot Pinning

Очень полезная возможность:

```bash
featuresync snapshot \
  --environment staging \
  --version 42
```

Теперь pipeline гарантированно использует:

```text
version = 42
```

даже если staging уже перешёл на version 43.

---

# 20. Runtime synchronization

При startup:

```text
Application
    ↓
S3
    ↓
validate
    ↓
memory cache
```

После изменения:

```text
S3
 ↓
SNS
 ↓
Application
 ↓
download new snapshot
 ↓
validate
 ↓
atomic swap
```

Важно:

```text
old snapshot
      ↓
validate new snapshot
      ↓
success
      ↓
atomic replace
```

Если новый snapshot повреждён:

```text
old snapshot remains active
```

Это очень важная production-гарантия.

---

# 21. Atomic configuration update

Нельзя делать:

```typescript
cache.flags = partiallyLoadedFlags;
```

Лучше:

```typescript
const next = validate(snapshot);

cache.replace(next);
```

В каждый момент runtime видит **либо старую целую конфигурацию, либо новую целую конфигурацию**.

---

# 22. Failure Modes

Нужно заранее определить поведение.

### S3 недоступен при startup

```text
No local snapshot
       ↓
application startup fails
```

или configurable:

```text
allowStaleStartup = true
```

### S3 недоступен после startup

```text
continue using last valid snapshot
```

### SNS недоступен

Не страшно.

Periodic reconciliation:

```text
every 5-15 minutes
```

может проверить актуальную версию.

### Новый snapshot invalid

```text
reject
keep old version
log error
```

---

# 23. Metrics

SDK может предоставлять:

```text
featuresync_snapshot_version
featuresync_snapshot_age
featuresync_sync_total
featuresync_sync_errors
featuresync_evaluation_total
```

Но **не отправлять telemetry наружу автоматически**.

Пользователь сам подключает:

- OpenTelemetry;
- Prometheus;
- Datadog;
- New Relic.

Это соответствует концепции лёгкой библиотеки.

---

# 24. Audit

Snapshot metadata:

```json
{
  "version": 44,
  "environment": "production",
  "createdAt": "...",
  "createdBy": "dimitry",
  "previousVersion": 43,
  "reason": "Enable new checkout"
}
```

UI:

```text
v44
Dimitry
2 minutes ago

Enable new checkout
```

---

# 25. Packages

Я бы сделал monorepo:

```text
featuresync/
│
├── packages/
│   ├── core/
│   ├── nestjs/
│   ├── aws/
│   ├── cli/
│   ├── schema/
│   └── sdk/
│
├── apps/
│   └── dashboard/
│
├── infrastructure/
│   └── aws/
│
└── examples/
    ├── nestjs
    ├── express
    └── ci
```

Но публично можно оставить очень простую модель:

```text
@featuresync/core
@featuresync/nestjs
@featuresync/aws
featuresync
```

---

# 26. Технологический стек

### Core

```text
TypeScript
Zod
```

### NestJS

```text
NestJS
TypeScript
```

### AWS

```text
AWS SDK v3
S3
SNS
Lambda
IAM
```

### UI

```text
React
Vite
TypeScript
MUI
```

### CLI

```text
TypeScript
Commander / Yargs
AWS SDK
```

### Infrastructure

Я бы использовал **AWS CDK** для создания инфраструктуры.

Причина: весь deployment остаётся TypeScript и хорошо сочетается с твоим стеком.

---

# 27. MVP — что реально сделать первым

Не пытаться сделать всё.

### Phase 1 — Core

- `isEnabled()`
- `get()`
- `evaluate()`
- local JSON provider
- schema validation
- immutable snapshot
- version

### Phase 2 — AWS

- S3
- SNS
- Lambda
- IAM
- startup sync
- SNS sync
- fallback

### Phase 3 — NestJS

- Module
- Service
- decorators
- guard

### Phase 4 — CLI

```bash
init
validate
pull
snapshot
publish
rollback
```

### Phase 5 — UI

- environments
- feature list
- boolean flags
- typed configuration
- schema-generated forms
- version history
- publish
- rollback

### Phase 6 — CI/CD

- GitHub Actions example
- snapshot command
- pinned versions
- offline testing

---

# 28. Что сознательно НЕ делать в MVP

Это важно.

Не делать:

- analytics;
- experimentation;
- A/B testing;
- user analytics;
- Redis;
- database;
- Kubernetes operator;
- custom authentication;
- billing;
- percentage rollout;
- complex targeting DSL;
- 20 cloud providers;
- десятки SDK.

Иначе проект быстро превратится в ещё один PostHog.

---

# 29. Главная архитектурная фишка

Я бы позиционировал продукт не как:

> **Feature Flag Service**

а как:

> **Local-first Feature Configuration Runtime**

Потому что у тебя два use case:

```text
Feature flags
      +
Typed configuration
      +
Local evaluation
```

Например:

```typescript
flags.isEnabled("new-checkout");
```

и:

```typescript
const config = flags.evaluate("checkout", user);
```

Оба используют один snapshot.

---

# 30. Конечный developer experience

В идеале новый пользователь должен пройти путь примерно такой:

```bash
npx featuresync init
```

CLI:

```text
✓ AWS account detected
✓ Region: eu-central-1

Create FeatureSync infrastructure?

✓ S3 bucket
✓ SNS topic
✓ Lambda publisher
✓ IAM roles

✓ FeatureSync is ready

Environment:
  production

Bucket:
  my-app-featuresync

Add NestJS integration?
  Yes
```

Затем:

```bash
npm install @featuresync/nestjs
```

```typescript
@Module({
  imports: [
    FeatureSyncModule.forRoot({
      environment: "production",
    }),
  ],
})
export class AppModule {}
```

И:

```typescript
const config = this.flags.evaluate("payment-flow", {
  plan: user.plan,
});
```

**Всё.**

Без database, Redis, отдельного backend и обязательного SaaS.

---

# 31. Самое важное конкурентное преимущество

Я бы сформулировал его так:

> **Your feature flags live in your AWS account, your applications evaluate them locally, and your CI pipelines can pin the exact configuration they tested.**

То есть одновременно:

**Vendor independence**
→ нет зависимости от PostHog/LaunchDarkly.

**Low runtime cost**
→ evaluation не требует сетевого запроса.

**Fast**
→ memory lookup.

**Reliable**
→ последний валидный snapshot.

**Reproducible CI/CD**
→ pinned snapshot.

**Typed**
→ Zod + TypeScript.

**AWS-native**
→ S3/SNS/Lambda/IAM.

**Simple**
→ несколько AWS primitives вместо собственной распределённой платформы.

---

## Архитектура MVP в одной картинке

![Image](https://images.openai.com/static-rsc-4/G8XFYaJ0RumrLUUEBClH1g-TL9YWCRpOPl2gWQcSKVWvd5orxYuvYvRfeYQIbdVB0RnlHNaY_N9zQDxo2l_mQP3Gp06pEVEDCCmHCMFBtnIIt7wE8a4PGY7jOfNM5MmBQGL-LcZuJmokfHBQBk7Xwn2QG0QsJ3cZlPTd5x-Lp5rc_BLBsAV9Ged6iLwJb-vO?purpose=fullsize)

![Image](https://images.openai.com/static-rsc-4/AAxeBi_xGwtm4JnhHMWiVjtrnmzUUyV2mpZ5FRQBdW7-IFGH3Jb1TwEPeirqWKD1R8oW508BjpGTHTj3jzVz3ydjIzkphFp1aJ0SGAGTZKtLqpHXGwOYnsJa-TjilNQJjcO4u1QQQjj--i-TyNMJvRgW1Yz4DFfmPMYLfBoB660qBjqqbiFf5sRevZll9wbB?purpose=fullsize)

![Image](https://images.openai.com/static-rsc-4/bnymmOg8x1WwCXkx2Ejs_LQ0oZIHmTi4F4UP-ghZsD53vKWH0oQpMjDSgotJU9LRvjWkh8COlUd_Yu7Uep27KFoMVxj7bnIc1RKrJOoz-Q5VfEE_lmBfKE3D9q8fmLDZ-fIY-iXijVADu3eJ7Cm9-WiLpYi-3hDN1ZCvi3Fe7dm42fkZgQ0MxGtTop-cYa5F?purpose=fullsize)

```text
                       ┌───────────────────┐
                       │   FeatureSync UI  │
                       │                   │
                       │ Flags / Config    │
                       │ Schema / Rules    │
                       │ Versions          │
                       │ Publish / Rollback│
                       └─────────┬─────────┘
                                 │
                                 ▼
                       ┌───────────────────┐
                       │       S3          │
                       │                   │
                       │ Immutable         │
                       │ Snapshots         │
                       └─────────┬─────────┘
                                 │
                                 ▼
                       ┌───────────────────┐
                       │      Lambda       │
                       │ Validate/Publish  │
                       └─────────┬─────────┘
                                 │
                                 ▼
                       ┌───────────────────┐
                       │       SNS         │
                       └─────────┬─────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                  │
              ▼                  ▼                  ▼
       ┌────────────┐     ┌────────────┐     ┌────────────┐
       │  NestJS    │     │  NestJS    │     │  Node.js   │
       │   App #1   │     │   App #2   │     │   App #N   │
       ├────────────┤     ├────────────┤     ├────────────┤
       │ Local      │     │ Local      │     │ Local      │
       │ Snapshot   │     │ Snapshot   │     │ Snapshot   │
       │ Evaluator  │     │ Evaluator  │     │ Evaluator  │
       └────────────┘     └────────────┘     └────────────┘
              │                  │                  │
              └──────────────────┼──────────────────┘
                                 │
                         0 requests/request
```

**Я бы именно эту версию считал базовой спецификацией проекта.** Самая большая техническая ценность здесь не S3/SNS — это **локальный typed evaluation engine + immutable versioned snapshots + безопасная синхронизация + воспроизводимость CI/CD**. AWS при этом остаётся дешёвым и практически невидимым инфраструктурным слоем.
