export const errorShape = (error: unknown): { name?: unknown; status?: unknown } => {
  if (typeof error !== 'object' || error === null) return {};
  const { name, $metadata } = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return { name, status: $metadata?.httpStatusCode };
};
