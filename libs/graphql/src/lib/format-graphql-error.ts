import {
  ApolloServerErrorCode,
  unwrapResolverError,
} from '@apollo/server/errors';
import { HttpException, HttpStatus } from '@nestjs/common';
import type { GraphQLFormattedError } from 'graphql';

type SafeError = Readonly<{
  code: string;
  message: string;
}>;

type HttpErrorBody = {
  code?: unknown;
  message?: unknown;
  action?: unknown;
  retryAfter?: unknown;
};

const INTERNAL_ERROR: SafeError = {
  code: ApolloServerErrorCode.INTERNAL_SERVER_ERROR,
  message: 'Internal server error',
};

const HTTP_ERROR: SafeError = {
  code: 'HTTP_ERROR',
  message: 'Request failed',
};

const HTTP_ERRORS: Readonly<Partial<Record<number, SafeError>>> = {
  [HttpStatus.BAD_REQUEST]: {
    code: ApolloServerErrorCode.BAD_REQUEST,
    message: 'Bad request',
  },
  [HttpStatus.UNAUTHORIZED]: {
    code: 'UNAUTHENTICATED',
    message: 'Unauthenticated',
  },
  [HttpStatus.FORBIDDEN]: { code: 'FORBIDDEN', message: 'Forbidden' },
  [HttpStatus.NOT_FOUND]: { code: 'NOT_FOUND', message: 'Not found' },
  [HttpStatus.CONFLICT]: { code: 'CONFLICT', message: 'Conflict' },
  [HttpStatus.TOO_MANY_REQUESTS]: {
    code: 'TOO_MANY_REQUESTS',
    message: 'Too many requests',
  },
};

const SAFE_REQUEST_CODES = new Set<string>([
  ApolloServerErrorCode.GRAPHQL_PARSE_FAILED,
  ApolloServerErrorCode.GRAPHQL_VALIDATION_FAILED,
]);

function createFormattedError(
  formattedError: GraphQLFormattedError,
  error: SafeError,
  extensions: Record<string, unknown> = {},
): GraphQLFormattedError {
  return {
    message: error.message,
    ...(formattedError.locations !== undefined
      ? { locations: formattedError.locations }
      : {}),
    ...(formattedError.path !== undefined ? { path: formattedError.path } : {}),
    extensions: { code: error.code, ...extensions },
  };
}

export function createGraphQLErrorFormatter(publicCodes: ReadonlySet<string>) {
  return (
    formattedError: GraphQLFormattedError,
    error: unknown,
  ): GraphQLFormattedError => {
    const exception = unwrapResolverError(error);

    if (!(exception instanceof HttpException)) {
      const code = formattedError.extensions?.['code'];

      if (formattedError.path === undefined && typeof code === 'string') {
        if (SAFE_REQUEST_CODES.has(code)) {
          return createFormattedError(formattedError, {
            code,
            message: formattedError.message,
          });
        }

        if (code === ApolloServerErrorCode.BAD_USER_INPUT) {
          return createFormattedError(formattedError, {
            code,
            message: 'Bad request',
          });
        }
      }

      return createFormattedError(formattedError, INTERNAL_ERROR);
    }

    const response = exception.getResponse();
    const body: HttpErrorBody =
      typeof response === 'object' && response !== null ? response : {};
    const publicCode =
      typeof body.code === 'string' && publicCodes.has(body.code)
        ? body.code
        : undefined;
    const status = exception.getStatus();
    const fallback =
      HTTP_ERRORS[status] ??
      (status >= HttpStatus.INTERNAL_SERVER_ERROR
        ? INTERNAL_ERROR
        : HTTP_ERROR);
    const extensions: Record<string, unknown> = {};

    if (publicCode && typeof body.action === 'string') {
      extensions['action'] = body.action;
    }

    if (
      publicCode &&
      typeof body.retryAfter === 'number' &&
      Number.isFinite(body.retryAfter) &&
      body.retryAfter >= 0
    ) {
      extensions['retryAfter'] = body.retryAfter;
    }

    return createFormattedError(
      formattedError,
      {
        code: publicCode ?? fallback.code,
        message:
          publicCode && typeof body.message === 'string'
            ? body.message
            : fallback.message,
      },
      extensions,
    );
  };
}
