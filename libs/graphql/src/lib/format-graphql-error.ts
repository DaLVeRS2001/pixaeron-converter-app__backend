import { unwrapResolverError } from '@apollo/server/errors';
import { HttpException, HttpStatus } from '@nestjs/common';
import type { GraphQLFormattedError } from 'graphql';

const HTTP_STATUS_CODES: Partial<Record<HttpStatus, string>> = {
  [HttpStatus.BAD_REQUEST]: 'BAD_REQUEST',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHENTICATED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.TOO_MANY_REQUESTS]: 'TOO_MANY_REQUESTS',
};

const SAFE_HTTP_MESSAGES: Partial<Record<HttpStatus, string>> = {
  [HttpStatus.BAD_REQUEST]: 'Bad request',
  [HttpStatus.UNAUTHORIZED]: 'Unauthenticated',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.NOT_FOUND]: 'Not found',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.TOO_MANY_REQUESTS]: 'Too many requests',
};

const SAFE_GRAPHQL_REQUEST_ERROR_CODES = new Set([
  'GRAPHQL_PARSE_FAILED',
  'GRAPHQL_VALIDATION_FAILED',
]);

type GraphQLErrorFormatterOptions = {
  publicCodes: ReadonlySet<string>;
};

const DEFAULT_PUBLIC_CODES = new Set<string>();

export function createGraphQLErrorFormatter({
  publicCodes,
}: GraphQLErrorFormatterOptions) {
  return (
    formattedError: GraphQLFormattedError,
    error: unknown,
  ): GraphQLFormattedError => {
    const exception = unwrapResolverError(error);

    if (!(exception instanceof HttpException)) {
      const code = formattedError.extensions?.code;

      if (
        formattedError.path === undefined &&
        typeof code === 'string' &&
        SAFE_GRAPHQL_REQUEST_ERROR_CODES.has(code)
      ) {
        return {
          message: formattedError.message,
          ...(formattedError.locations
            ? { locations: formattedError.locations }
            : {}),
          extensions: { code },
        };
      }

      return {
        message: 'Internal server error',
        ...(formattedError.locations
          ? { locations: formattedError.locations }
          : {}),
        ...(formattedError.path ? { path: formattedError.path } : {}),
        extensions: { code: 'INTERNAL_SERVER_ERROR' },
      };
    }

    const response = exception.getResponse();
    const body =
      typeof response === 'object' && response !== null
        ? (response as Record<string, unknown>)
        : undefined;
    const status = exception.getStatus();
    const candidateCode =
      typeof body?.code === 'string' ? body.code : undefined;
    const publicCode =
      candidateCode && publicCodes.has(candidateCode)
        ? candidateCode
        : undefined;
    const fallbackCode =
      HTTP_STATUS_CODES[status] ??
      (status >= HttpStatus.INTERNAL_SERVER_ERROR
        ? 'INTERNAL_SERVER_ERROR'
        : 'HTTP_ERROR');

    return {
      message:
        publicCode && typeof body?.message === 'string'
          ? body.message
          : status >= HttpStatus.INTERNAL_SERVER_ERROR
            ? 'Internal server error'
            : (SAFE_HTTP_MESSAGES[status] ?? 'Request failed'),
      ...(formattedError.locations
        ? { locations: formattedError.locations }
        : {}),
      ...(formattedError.path ? { path: formattedError.path } : {}),
      extensions: {
        code: publicCode ?? fallbackCode,
        ...(publicCode && typeof body?.action === 'string'
          ? { action: body.action }
          : {}),
        ...(publicCode &&
        typeof body?.retryAfter === 'number' &&
        Number.isFinite(body.retryAfter) &&
        body.retryAfter >= 0
          ? { retryAfter: body.retryAfter }
          : {}),
      },
    };
  };
}

export const formatGraphQLError = createGraphQLErrorFormatter({
  publicCodes: DEFAULT_PUBLIC_CODES,
});

export type { GraphQLErrorFormatterOptions };
