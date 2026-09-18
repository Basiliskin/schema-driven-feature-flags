import 'reflect-metadata';
import { Controller, ForbiddenException, Get, Module, NotFoundException, UseGuards, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { FeatureFlags } from '@featuresync/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Feature, FeatureFlagGuard, FeatureSyncModule, type FeatureGuardOptions } from '../src/index.js';
import { silentLogger, staticSource } from './fixtures.js';

class Dashboard {
  @Feature('new-dashboard')
  show(): string {
    return 'dashboard';
  }

  @Feature('missing-flag')
  missing(): string {
    return 'missing';
  }

  open(): string {
    return 'open';
  }
}

@Feature('missing-flag')
class Beta {
  inherited(): string {
    return 'beta';
  }

  @Feature('new-dashboard')
  overridden(): string {
    return 'overridden';
  }
}

const contextFor = (target: new () => object, method: string): ExecutionContext =>
  ({
    getHandler: () => (target.prototype as Record<string, unknown>)[method],
    getClass: () => target,
  }) as unknown as ExecutionContext;

const flagsWith = (enabled: Record<string, boolean>) => {
  const isEnabled = vi.fn<(key: string, context?: unknown) => boolean>((key) => enabled[key] ?? false);
  return { isEnabled, client: { isEnabled } as unknown as FeatureFlags };
};

const guardWith = ({ client }: { client: FeatureFlags }, options: FeatureGuardOptions = {}) =>
  new FeatureFlagGuard(new Reflector(), client, options);

describe('FeatureFlagGuard', () => {
  const flags = flagsWith({ 'new-dashboard': true, 'old-dashboard': false });

  it('allows a handler whose flag is enabled', () => {
    expect(guardWith(flags).canActivate(contextFor(Dashboard, 'show'))).toBe(true);
    expect(flags.isEnabled).toHaveBeenCalledWith('new-dashboard', undefined);
  });

  it('allows a handler without @Feature without evaluating any flag', () => {
    const untouched = flagsWith({});

    expect(guardWith(untouched).canActivate(contextFor(Dashboard, 'open'))).toBe(true);
    expect(untouched.isEnabled).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the flag is disabled', () => {
    const disabled = flagsWith({ 'new-dashboard': false });

    expect(() => guardWith(disabled).canActivate(contextFor(Dashboard, 'show'))).toThrow(NotFoundException);
  });

  it('throws NotFoundException when the flag is unknown', () => {
    expect(() => guardWith(flags).canActivate(contextFor(Dashboard, 'missing'))).toThrow(NotFoundException);
  });

  it('gates every handler of a controller class marked with @Feature', () => {
    expect(() => guardWith(flags).canActivate(contextFor(Beta, 'inherited'))).toThrow(NotFoundException);
    expect(flags.isEnabled).toHaveBeenCalledWith('missing-flag', undefined);
  });

  it('lets handler metadata override controller metadata', () => {
    expect(guardWith(flags).canActivate(contextFor(Beta, 'overridden'))).toBe(true);
  });

  it('throws the configured exception with the flag key', () => {
    const forbidden = new ForbiddenException('beta only');
    const guardException = vi.fn(() => forbidden);

    const act = () => guardWith(flags, { guardException }).canActivate(contextFor(Dashboard, 'missing'));

    expect(act).toThrow(forbidden);
    expect(guardException).toHaveBeenCalledExactlyOnceWith('missing-flag');
  });

  it('evaluates the flag against the context built from the request', () => {
    const evaluationContext = { isEmployee: true };
    const executionContext = contextFor(Dashboard, 'show');
    const contextFrom = vi.fn(() => evaluationContext);

    guardWith(flags, { contextFrom }).canActivate(executionContext);

    expect(contextFrom).toHaveBeenCalledExactlyOnceWith(executionContext);
    expect(flags.isEnabled).toHaveBeenLastCalledWith('new-dashboard', evaluationContext);
  });
});

@Controller('reports')
@UseGuards(FeatureFlagGuard)
class ReportsController {
  @Get('dashboard')
  @Feature('new-dashboard')
  dashboard(): string {
    return 'dashboard';
  }

  @Get('payments')
  @Feature('payment-flow')
  payments(): string {
    return 'payments';
  }

  @Get('legacy')
  @Feature('legacy-reports')
  legacy(): string {
    return 'legacy';
  }
}

@Module({ controllers: [ReportsController] })
// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest modules are declared by decorator alone
class ReportsModule {}

const apps: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const httpContext = (handler: keyof ReportsController, request: object): ExecutionContext =>
  ({
    ...contextFor(ReportsController, handler),
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext;

const requestUser = (context: ExecutionContext) =>
  context.switchToHttp().getRequest<{ user: { isEmployee: boolean } }>().user;

describe('FeatureFlagGuard through FeatureSyncModule', () => {
  it('is resolved with the module client and default exception via forRoot', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FeatureSyncModule.forRoot({ source: staticSource(), logger: silentLogger }), ReportsModule],
    }).compile();
    await moduleRef.init();
    apps.push(moduleRef);
    const guard = moduleRef.get(FeatureFlagGuard);

    expect(guard.canActivate(httpContext('payments', {}))).toBe(true);
    expect(() => guard.canActivate(httpContext('legacy', {}))).toThrow(NotFoundException);
  });

  it('uses contextFrom and guardException given to forRootAsync', async () => {
    const guardException = (key: string) => new ForbiddenException(key);
    const moduleRef = await Test.createTestingModule({
      imports: [
        FeatureSyncModule.forRootAsync({
          useFactory: () => ({ source: staticSource(), logger: silentLogger }),
          contextFrom: requestUser,
          guardException,
        }),
        ReportsModule,
      ],
    }).compile();
    await moduleRef.init();
    apps.push(moduleRef);
    const guard = moduleRef.get(FeatureFlagGuard);

    expect(guard.canActivate(httpContext('dashboard', { user: { isEmployee: true } }))).toBe(true);
    expect(() => guard.canActivate(httpContext('dashboard', { user: { isEmployee: false } }))).toThrow(
      new ForbiddenException('new-dashboard'),
    );
  });

  it('is resolvable in a feature module when the module is not global', async () => {
    @Module({ imports: [FeatureSyncModule.forRoot({ source: staticSource(), logger: silentLogger, isGlobal: false })], controllers: [ReportsController] })
    // eslint-disable-next-line @typescript-eslint/no-extraneous-class -- Nest modules are declared by decorator alone
    class ScopedReportsModule {}

    const moduleRef = await Test.createTestingModule({ imports: [ScopedReportsModule] }).compile();
    await moduleRef.init();
    apps.push(moduleRef);

    expect(moduleRef.get(FeatureFlagGuard).canActivate(httpContext('payments', {}))).toBe(true);
  });
});
