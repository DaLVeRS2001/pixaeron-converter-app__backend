import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import {
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
} from '@pixaeron/graphql';
import { lexicographicSortSchema, printSchema } from 'graphql';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const outputPath = resolve('apps/auth/schema.graphql');
const checkOnly = process.argv.includes('--check');

type ResolverReference = Parameters<GraphQLSchemaFactory['create']>[0][number];

async function findResolverFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);

      if (entry.isDirectory()) return findResolverFiles(path);
      return entry.name.endsWith('.resolver.ts') ? [path] : [];
    }),
  );

  return files.flat().sort();
}

async function loadResolvers() {
  const resolverFiles = await findResolverFiles(resolve('apps/auth/src/app'));
  const resolverModules = await Promise.all(
    resolverFiles.map((resolverFile) => import(resolverFile)),
  );

  return resolverModules.flatMap((resolverModule) =>
    Object.entries(resolverModule)
      .filter(
        ([name, exported]) =>
          name.endsWith('Resolver') && typeof exported === 'function',
      )
      .map(([, resolver]) => resolver as ResolverReference),
  );
}
async function main() {
  const application = await NestFactory.createApplicationContext(
    GraphQLSchemaBuilderModule,
    { logger: false },
  );

  try {
    const schemaFactory = application.get(GraphQLSchemaFactory);
    const schema = await schemaFactory.create(await loadResolvers());
    const generatedSchema = [
      '# GENERATED FILE. DO NOT EDIT MANUALLY.',
      '# Source of truth: NestJS code-first resolvers and models in apps/auth.',
      '',
      printSchema(lexicographicSortSchema(schema)),
      '',
    ].join('\n');

    if (checkOnly) {
      let currentSchema: string;

      try {
        currentSchema = await readFile(outputPath, 'utf8');
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          throw new Error(
            `GraphQL schema snapshot is missing at ${outputPath}. Run npm run schema:export:auth.`,
          );
        }

        throw error;
      }

      if (currentSchema !== generatedSchema) {
        throw new Error(
          'GraphQL schema snapshot is stale. Run npm run schema:export:auth and commit the result.',
        );
      }

      process.stdout.write(
        `GraphQL schema snapshot is current: ${outputPath}\n`,
      );
    } else {
      await writeFile(outputPath, generatedSchema, 'utf8');
      process.stdout.write(`GraphQL schema written to ${outputPath}\n`);
    }
  } finally {
    await application.close();
  }
}

void main();
