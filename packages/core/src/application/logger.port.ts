/** Receives failures the flag client recovers from instead of throwing. */
export interface Logger {
  error(message: string, error: unknown): void;
}

export const consoleLogger: Logger = {
  error: (message, error) => {
    console.error(`[featuresync] ${message}`, error);
  },
};
