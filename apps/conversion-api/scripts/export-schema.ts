import 'reflect-metadata';

import { Test } from '@nestjs/testing';
import {
  ApolloFederationDriver,
  ApolloFederationDriverConfig,
  GraphQLModule,
  GraphQLSchemaHost,
} from '@pixaeron/graphql';
import { graphql, type ExecutionResult } from 'graphql';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { CONVERSION_RESOLVERS } from '../src/app/conversion/conversion.module';

const schemaPath = resolve(__dirname, '../schema.graphql');

type ServiceSdlData = {
  _service: { sdl: string };
};

async function generateSchema(): Promise<string> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      GraphQLModule.forRoot<ApolloFederationDriverConfig>({
        driver: ApolloFederationDriver,
        autoSchemaFile: { federation: 2 },
        sortSchema: true,
      }),
    ],
    providers: [...CONVERSION_RESOLVERS],
  })
    .useMocker(() => ({}))
    .compile();

  try {
    await moduleRef.init();

    const result = (await graphql({
      schema: moduleRef.get(GraphQLSchemaHost).schema,
      source: '{ _service { sdl } }',
    })) as ExecutionResult<ServiceSdlData>;

    if (result.errors?.length) {
      throw new Error(result.errors.map((error) => error.message).join('\n'));
    }

    if (!result.data) {
      throw new Error('Federation schema query returned no data.');
    }

    return [
      '# GENERATED FILE. DO NOT EDIT MANUALLY.',
      '# Source of truth: NestJS code-first resolvers and models in apps/conversion-api.',
      '# Contract: Apollo Federation 2 subgraph SDL.',
      '',
      result.data._service.sdl.trim(),
      '',
    ].join('\n');
  } finally {
    await moduleRef.close();
  }
}

async function main(): Promise<void> {
  const generatedSchema = await generateSchema();

  if (process.argv.includes('--check')) {
    const currentSchema = await readFile(schemaPath, 'utf8');

    if (currentSchema !== generatedSchema) {
      throw new Error('GraphQL schema is stale. Run npm run schema:export.');
    }

    process.stdout.write(`GraphQL schema is current: ${schemaPath}\n`);
    return;
  }

  await writeFile(schemaPath, generatedSchema, 'utf8');
  process.stdout.write(`GraphQL schema written to ${schemaPath}\n`);
}

void main();
