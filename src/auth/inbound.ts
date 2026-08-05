export interface AuthContext {
  bearerToken: string;
}

export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

type Headers = Record<string, string | string[] | undefined>;

function header(headers: Headers, name: string): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

export function authenticate(headers: Headers): AuthContext {
  const auth = header(headers, "authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (!match || !match[1]) {
    throw new AuthError(401, "missing upstream token");
  }

  return { bearerToken: match[1] };
}

export function authenticateFromEnv(
  env: NodeJS.ProcessEnv,
  tokenEnv: string,
): AuthContext {
  const raw = env[tokenEnv];
  if (!raw) {
    throw new AuthError(401, "missing upstream token");
  }
  return { bearerToken: raw };
}
