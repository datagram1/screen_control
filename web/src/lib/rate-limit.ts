/**
 * In-Memory Rate Limiter
 *
 * Provides rate limiting for API endpoints using a sliding window algorithm.
 * Suitable for single-server deployments. For multi-server deployments,
 * consider using Redis-backed rate limiting (e.g., @upstash/ratelimit).
 */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface RateLimitConfig {
  /** Maximum number of requests allowed in the window */
  limit: number;
  /** Window duration in seconds */
  windowSeconds: number;
}

interface RateLimitResult {
  /** Whether the request is allowed */
  success: boolean;
  /** Number of requests remaining in the window */
  remaining: number;
  /** Unix timestamp when the limit resets */
  reset: number;
  /** Total limit for the window */
  limit: number;
}

/**
 * In-memory store for rate limit entries
 * Key format: `${identifier}:${limiterName}`
 */
const rateLimitStore = new Map<string, RateLimitEntry>();

/**
 * Cleanup interval to remove expired entries (runs every 60 seconds)
 */
let cleanupInterval: NodeJS.Timeout | null = null;

function startCleanup() {
  if (cleanupInterval) return;

  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitStore.entries()) {
      if (entry.resetAt < now) {
        rateLimitStore.delete(key);
      }
    }
  }, 60000);

  // Don't prevent process exit
  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }
}

/**
 * Check rate limit for an identifier
 *
 * @param identifier - Unique identifier (e.g., IP address, user ID)
 * @param limiterName - Name of the rate limiter (for different limits on different endpoints)
 * @param config - Rate limit configuration
 * @returns Rate limit result
 */
export function checkRateLimit(
  identifier: string,
  limiterName: string,
  config: RateLimitConfig
): RateLimitResult {
  startCleanup();

  const key = `${identifier}:${limiterName}`;
  const now = Date.now();
  const windowMs = config.windowSeconds * 1000;

  let entry = rateLimitStore.get(key);

  // If no entry or window expired, create new entry
  if (!entry || entry.resetAt < now) {
    entry = {
      count: 1,
      resetAt: now + windowMs,
    };
    rateLimitStore.set(key, entry);

    return {
      success: true,
      remaining: config.limit - 1,
      reset: entry.resetAt,
      limit: config.limit,
    };
  }

  // Check if limit exceeded
  if (entry.count >= config.limit) {
    return {
      success: false,
      remaining: 0,
      reset: entry.resetAt,
      limit: config.limit,
    };
  }

  // Increment count
  entry.count++;

  return {
    success: true,
    remaining: config.limit - entry.count,
    reset: entry.resetAt,
    limit: config.limit,
  };
}

/**
 * Pre-configured rate limiters for different endpoints
 */
export const RateLimiters = {
  /**
   * OAuth client registration - strict limit to prevent abuse
   * 10 registrations per hour per IP
   */
  oauthRegister: (identifier: string) =>
    checkRateLimit(identifier, 'oauth:register', {
      limit: 10,
      windowSeconds: 3600, // 1 hour
    }),

  /**
   * OAuth token endpoint - moderate limit
   * 60 requests per minute per IP (allows for retries)
   */
  oauthToken: (identifier: string) =>
    checkRateLimit(identifier, 'oauth:token', {
      limit: 60,
      windowSeconds: 60, // 1 minute
    }),

  /**
   * OAuth authorization - prevent brute force
   * 30 requests per minute per IP
   */
  oauthAuthorize: (identifier: string) =>
    checkRateLimit(identifier, 'oauth:authorize', {
      limit: 30,
      windowSeconds: 60, // 1 minute
    }),

  /**
   * MCP endpoint - per-connection rate limit
   * 1000 requests per minute per connection (high limit for authenticated users)
   */
  mcpRequest: (connectionId: string) =>
    checkRateLimit(connectionId, 'mcp:request', {
      limit: 1000,
      windowSeconds: 60, // 1 minute
    }),

  /**
   * MCP endpoint - per-IP rate limit (fallback for unauthenticated)
   * 20 requests per minute per IP
   */
  mcpUnauthenticated: (identifier: string) =>
    checkRateLimit(identifier, 'mcp:unauth', {
      limit: 20,
      windowSeconds: 60, // 1 minute
    }),
};

/**
 * Extract client IP from request headers
 */
export function getClientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }

  const realIp = request.headers.get('x-real-ip');
  if (realIp) {
    return realIp;
  }

  // Fallback for development
  return '127.0.0.1';
}

/**
 * Create rate limit response headers
 */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Limit': result.limit.toString(),
    'X-RateLimit-Remaining': result.remaining.toString(),
    'X-RateLimit-Reset': Math.ceil(result.reset / 1000).toString(),
  };
}

/**
 * Create a 429 Too Many Requests response
 */
export function rateLimitExceeded(result: RateLimitResult) {
  const retryAfter = Math.ceil((result.reset - Date.now()) / 1000);

  // Use dynamic import to avoid issues, return plain Response
  // which is compatible with both NextResponse and Response return types
  return Response.json(
    {
      error: 'too_many_requests',
      error_description: 'Rate limit exceeded. Please try again later.',
      retry_after: retryAfter,
    },
    {
      status: 429,
      headers: {
        'Retry-After': retryAfter.toString(),
        ...rateLimitHeaders(result),
      },
    }
  );
}
