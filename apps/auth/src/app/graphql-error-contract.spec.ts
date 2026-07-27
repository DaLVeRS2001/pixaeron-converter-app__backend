import {
  BadRequestException,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { formatAuthGraphQLError } from './graphql-error-contract';
import { GraphQLError } from 'graphql';

const formattedError = {
  message: 'Resolver failed',
  extensions: {
    code: 'INTERNAL_SERVER_ERROR',
    originalError: { message: 'Resolver failed' },
    stacktrace: ['private stack'],
  },
};

describe('GraphQL error contract', () => {
  it('exposes allowlisted public error metadata from an HttpException', () => {
    const exception = new BadRequestException({
      code: 'CAPTCHA_REQUIRED',
      action: 'google_login',
      message: 'Captcha verification is required',
      privateDetails: { providerResponse: 'must not leak' },
    });

    const result = formatAuthGraphQLError(
      formattedError,
      new GraphQLError(exception.message, {
        originalError: exception,
        path: ['googleLogin'],
      }),
    );

    expect(result).toMatchObject({
      message: 'Captcha verification is required',
      extensions: {
        code: 'CAPTCHA_REQUIRED',
        action: 'google_login',
      },
    });
    expect(result.extensions).not.toHaveProperty('originalError');
    expect(result.extensions).not.toHaveProperty('stacktrace');
    expect(result.extensions).not.toHaveProperty('privateDetails');
  });

  it('preserves an explicit public code for a service failure', () => {
    const exception = new ServiceUnavailableException({
      code: 'CAPTCHA_UNAVAILABLE',
      message: 'Captcha verification is temporarily unavailable',
    });

    const result = formatAuthGraphQLError(
      formattedError,
      new GraphQLError(exception.message, {
        originalError: exception,
        path: ['googleLogin'],
      }),
    );

    expect(result).toMatchObject({
      message: 'Captcha verification is temporarily unavailable',
      extensions: { code: 'CAPTCHA_UNAVAILABLE' },
    });
  });

  it('masks an unexpected server error', () => {
    const exception = new InternalServerErrorException('database details');

    const result = formatAuthGraphQLError(
      formattedError,
      new GraphQLError(exception.message, {
        originalError: exception,
        path: ['googleLogin'],
      }),
    );

    expect(result).toMatchObject({
      message: 'Internal server error',
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
  });

  it('masks a raw resolver error and removes private extensions', () => {
    const exception = new Error('connection string and query details');

    const result = formatAuthGraphQLError(
      { ...formattedError, path: ['me'] },
      new GraphQLError(exception.message, {
        originalError: exception,
        path: ['me'],
      }),
    );

    expect(result).toEqual({
      message: 'Internal server error',
      path: ['me'],
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
  });

  it('masks a Prisma-shaped resolver error', () => {
    const exception = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
      meta: { target: ['email'] },
    });

    const result = formatAuthGraphQLError(
      {
        ...formattedError,
        path: ['register'],
        extensions: {
          ...formattedError.extensions,
          code: exception.code,
          meta: exception.meta,
        },
      },
      new GraphQLError(exception.message, {
        originalError: exception,
        path: ['register'],
      }),
    );

    expect(result).toEqual({
      message: 'Internal server error',
      path: ['register'],
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
  });

  it.each(['GRAPHQL_PARSE_FAILED', 'GRAPHQL_VALIDATION_FAILED'])(
    'preserves the safe %s request error without private extensions',
    (code) => {
      const message = 'GraphQL request is invalid.';

      const result = formatAuthGraphQLError(
        {
          message,
          locations: [{ line: 1, column: 3 }],
          extensions: {
            code,
            stacktrace: ['private stack'],
          },
        },
        new GraphQLError(message, {
          extensions: { code },
        }),
      );

      expect(result).toEqual({
        message,
        locations: [{ line: 1, column: 3 }],
        extensions: { code },
      });
    },
  );

  it('returns a safe BAD_USER_INPUT for variable coercion errors', () => {
    const message = 'Variable "$email" got invalid value 123';
    const code = 'BAD_USER_INPUT';

    const result = formatAuthGraphQLError(
      {
        message,
        extensions: { code, stacktrace: ['private stack'] },
      },
      new GraphQLError(message, { extensions: { code } }),
    );

    expect(result).toEqual({
      message: 'Bad request',
      extensions: { code },
    });
  });
  it('masks an unknown HttpException code, message, and metadata', () => {
    const exception = new BadRequestException({
      code: 'INTERNAL_VALIDATION_DETAIL',
      message: 'private validation implementation details',
      action: 'private_action',
      retryAfter: 42,
    });

    const result = formatAuthGraphQLError(
      { ...formattedError, path: ['register'] },
      new GraphQLError(exception.message, {
        originalError: exception,
        path: ['register'],
      }),
    );

    expect(result).toEqual({
      message: 'Bad request',
      path: ['register'],
      extensions: { code: 'BAD_REQUEST' },
    });
  });
  it('does not trust a request-error code thrown from a resolver', () => {
    const exception = new GraphQLError('private resolver details', {
      extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
    });

    const result = formatAuthGraphQLError(
      {
        message: exception.message,
        path: ['me'],
        extensions: exception.extensions,
      },
      new GraphQLError(exception.message, {
        originalError: exception,
        path: ['me'],
      }),
    );

    expect(result).toEqual({
      message: 'Internal server error',
      path: ['me'],
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });
  });
});
