import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../src/main.js', () => ({ main: vi.fn(() => Promise.resolve(1)) }));

afterEach(() => {
  process.exitCode = undefined;
});

it('sets the process exit code from main', async () => {
  const { main } = await import('../src/main.js');

  await import('../src/bin.js');

  expect(main).toHaveBeenCalledWith(process.argv.slice(2));
  expect(process.exitCode).toBe(1);
});
