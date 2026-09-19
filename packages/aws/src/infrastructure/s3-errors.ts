export const errorShape = (error: unknown): { name?: unknown; status?: unknown } => {
  if (typeof error !== 'object' || error === null) return {};
  const { name, $metadata } = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return { name, status: $metadata?.httpStatusCode };
};

// S3 answers a lost conditional-write race with 412, or 409 while a competing write is in flight.
export const isPreconditionFailed = (error: unknown): boolean => {
  const { name, status } = errorShape(error);
  return name === 'PreconditionFailed' || name === 'ConditionalRequestConflict' || status === 412 || status === 409;
};
