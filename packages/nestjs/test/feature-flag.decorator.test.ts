import 'reflect-metadata';
import { Injectable, SetMetadata } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeatureFlag, FeatureSyncModule } from '../src/index.js';
import { silentLogger, snapshot, staticSource } from './fixtures.js';

const withDashboard = (enabled: boolean) => {
  const raw = snapshot();
  raw.features['new-dashboard'].enabled = enabled;
  raw.features['new-dashboard'].rules = [];
  return raw;
};

const apps: { close(): Promise<void> }[] = [];

const start = async (dashboardEnabled: boolean) => {
  const moduleRef = await Test.createTestingModule({
    imports: [FeatureSyncModule.forRoot({ source: staticSource(withDashboard(dashboardEnabled)), logger: silentLogger })],
    providers: [ReportService],
  }).compile();
  await moduleRef.init();
  apps.push(moduleRef);
  return moduleRef;
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const fallbackSpy = vi.fn((...args: unknown[]) => `fallback:${args.join(',')}`);

@Injectable()
class ReportService {
  readonly prefix = 'report';
  readonly original = vi.fn();

  @FeatureFlag('new-dashboard')
  build(id: string, format: string): string {
    this.original(id, format);
    return `${this.prefix}:${id}:${format}`;
  }

  @FeatureFlag('new-dashboard', {
    fallback(this: ReportService, id: string, format: string) {
      return fallbackSpy(this.prefix, id, format);
    },
  })
  buildOrFallback(id: string, format: string): string {
    this.original(id, format);
    return `${this.prefix}:${id}:${format}`;
  }

  @FeatureFlag('new-dashboard')
  async load(id: string): Promise<string> {
    this.original(id);
    return Promise.resolve(`${this.prefix}:${id}`);
  }

  @FeatureFlag('new-dashboard', { fallback: (id: string) => `cached:${id}` })
  async loadOrFallback(id: string): Promise<string> {
    this.original(id);
    return Promise.resolve(`${this.prefix}:${id}`);
  }

  @FeatureFlag('missing-flag')
  unknown(): string {
    this.original();
    return 'unknown';
  }
}

describe('@FeatureFlag with the flag on', () => {
  it('runs the original with the provider as this and passes its result through', async () => {
    const service = (await start(true)).get(ReportService);

    expect(service.build('42', 'pdf')).toBe('report:42:pdf');
    expect(service.original).toHaveBeenCalledExactlyOnceWith('42', 'pdf');
    expect(service.buildOrFallback('1', 'csv')).toBe('report:1:csv');
    expect(fallbackSpy).not.toHaveBeenCalled();
    await expect(service.load('7')).resolves.toBe('report:7');
  });
});

describe('@FeatureFlag with the flag off', () => {
  it('skips the original and returns undefined without a fallback', async () => {
    const service = (await start(false)).get(ReportService);

    expect(service.build('42', 'pdf')).toBeUndefined();
    expect(service.unknown()).toBeUndefined();
    expect(service.original).not.toHaveBeenCalled();
  });

  it('returns the fallback result, called with the same this and arguments', async () => {
    const service = (await start(false)).get(ReportService);

    expect(service.buildOrFallback('42', 'pdf')).toBe('fallback:report,42,pdf');
    expect(fallbackSpy).toHaveBeenCalledExactlyOnceWith('report', '42', 'pdf');
    expect(service.original).not.toHaveBeenCalled();
  });

  it('keeps async methods awaitable', async () => {
    const service = (await start(false)).get(ReportService);

    const skipped = service.load('7');
    const fallback = service.loadOrFallback('7');

    expect(skipped).toBeInstanceOf(Promise);
    expect(fallback).toBeInstanceOf(Promise);
    await expect(skipped).resolves.toBeUndefined();
    await expect(fallback).resolves.toBe('cached:7');
    expect(service.original).not.toHaveBeenCalled();
  });
});

describe('@FeatureFlag client lifecycle', () => {
  it('throws a clear error before any module has been initialised', () => {
    expect(() => new ReportService().build('42', 'pdf')).toThrow(/FeatureSyncModule has not been initialised/);
  });

  it('uses the newest app after the previous one closes', async () => {
    const first = await start(true);
    expect(first.get(ReportService).build('1', 'pdf')).toBe('report:1:pdf');
    await first.close();
    apps.splice(0);

    const service = (await start(false)).get(ReportService);
    expect(service.build('2', 'pdf')).toBeUndefined();
  });

  it('throws the same error after the app closes', async () => {
    const app = await start(true);
    const service = app.get(ReportService);
    await app.close();
    apps.splice(0);

    expect(() => service.build('42', 'pdf')).toThrow(/FeatureSyncModule has not been initialised/);
  });

  it('keeps the newer app bound when an older app closes later', async () => {
    const older = await start(false);
    const newer = await start(true);
    await older.close();
    apps.splice(apps.indexOf(older), 1);

    expect(newer.get(ReportService).build('3', 'pdf')).toBe('report:3:pdf');
  });
});

describe('@FeatureFlag wrapper', () => {
  it('keeps the method name', () => {
    expect(ReportService.prototype.build.name).toBe('build');
  });

  it('keeps metadata from decorators applied before it', () => {
    class Tagged {
      @SetMetadata('tag', 'outer')
      @FeatureFlag('new-dashboard')
      @SetMetadata('role', 'inner')
      run(): string {
        return 'run';
      }
    }

    const run: unknown = Object.getOwnPropertyDescriptor(Tagged.prototype, 'run')?.value;

    expect(Reflect.getMetadata('role', run as object)).toBe('inner');
    expect(Reflect.getMetadata('tag', run as object)).toBe('outer');
  });
});
