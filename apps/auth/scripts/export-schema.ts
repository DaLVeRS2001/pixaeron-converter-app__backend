import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import {
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
} from '@pixaeron/graphql';
import { lexicographicSortSchema, printSchema } from 'graphql';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { AUTH_RESOLVERS } from '../src/app/auth/auth.module';
import { USER_RESOLVERS } from '../src/app/user/user.module';

const schemaPath = resolve(__dirname, '../schema.graphql');

async function generateSchema(): Promise<string> {
  const app = await NestFactory.createApplicationContext(
    GraphQLSchemaBuilderModule,
    { logger: false },
  );

  try {
    const schemaFactory = app.get(GraphQLSchemaFactory);
    const schema = await schemaFactory.create([
      ...AUTH_RESOLVERS,
      ...USER_RESOLVERS,
    ]);

    return [
      '# GENERATED FILE. DO NOT EDIT MANUALLY.',
      '# Source of truth: NestJS code-first resolvers and models in apps/auth.',
      '',
      printSchema(lexicographicSortSchema(schema)),
      '',
    ].join('\n');
  } finally {
    await app.close();
  }
}

async function main(): Promise<void> {
  const generatedSchema = await generateSchema();

  if (process.argv.includes('--check')) {
    const currentSchema = await readFile(schemaPath, 'utf8');

    if (currentSchema !== generatedSchema) {
      throw new Error(
        'GraphQL schema is stale. Run npm run schema:export:auth.',
      );
    }

    process.stdout.write(`GraphQL schema is current: ${schemaPath}\n`);
    return;
  }

  await writeFile(schemaPath, generatedSchema, 'utf8');
  process.stdout.write(`GraphQL schema written to ${schemaPath}\n`);
}

void main();
