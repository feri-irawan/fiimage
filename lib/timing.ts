import { RequestTimeoutError } from "./errors";

export const withDeadline = async <T>(
  operation: Promise<T>,
  deadlineAt: number,
  message: string
) => {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new RequestTimeoutError(message);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new RequestTimeoutError(message)),
          remainingMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};
