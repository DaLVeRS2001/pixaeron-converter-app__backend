import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { isEmail } from 'class-validator';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { notificationsEnvironmentSchema } from './config/notifications-environment.schema';
import { RecipientHashService } from './delivery/recipient-hash.service';
import {
  EmailRecoveryService,
  type RecoveryEvidence,
} from './operations/email-recovery.service';
import { PrismaModule } from './prisma/prisma.module';

type RecoveryTransitionAction = 'request' | 'complete' | 'fail';

type RecoveryCommandInput =
  | { action: 'inspect'; recipient: string }
  | {
      action: RecoveryTransitionAction;
      recipient: string;
      evidence: RecoveryEvidence;
    };

export function createRecoveryCommandModule() {
  const configModule = ConfigModule.forRoot({
    isGlobal: true,
    validationSchema: notificationsEnvironmentSchema,
    validationOptions: { abortEarly: false, allowUnknown: true },
  });

  @Module({
    imports: [configModule, PrismaModule],
    providers: [RecipientHashService, EmailRecoveryService],
  })
  class RecoveryCommandModule {}

  return RecoveryCommandModule;
}

export async function runEmailRecoveryCommand(): Promise<void> {
  const input = parseRecoveryCommandInput(
    process.argv.slice(3),
    readFileSync(0, 'utf8'),
  );
  const context = await NestFactory.createApplicationContext(
    createRecoveryCommandModule(),
    { logger: ['error'] },
  );

  try {
    const service = context.get(EmailRecoveryService);

    switch (input.action) {
      case 'inspect': {
        const inspection = await service.inspectRecovery(input.recipient);
        process.stdout.write(`${JSON.stringify(inspection)}\n`);
        return;
      }
      case 'request':
        await service.requestRecovery(input.recipient, input.evidence);
        break;
      case 'complete':
        await service.completeRecovery(input.recipient, input.evidence);
        break;
      case 'fail':
        await service.failRecovery(input.recipient, input.evidence);
        break;
    }

    process.stdout.write('Email recovery state transition completed\n');
  } finally {
    await context.close();
  }
}

export function parseRecoveryCommandInput(
  args: string[],
  recipientInput: string,
): RecoveryCommandInput {
  const { values } = parseArgs({
    args,
    options: {
      action: { type: 'string' },
      'operation-id': { type: 'string' },
      'suppression-revision': { type: 'string' },
      actor: { type: 'string' },
      reason: { type: 'string' },
      evidence: { type: 'string' },
      'provider-request': { type: 'string' },
    },
    strict: true,
  });

  const action = values.action as RecoveryCommandInput['action'] | undefined;
  if (!action || !['inspect', 'request', 'complete', 'fail'].includes(action)) {
    throw new Error('action must be inspect, request, complete, or fail');
  }

  const recipient = required(recipientInput, 'recipient', 320);
  if (!isEmail(recipient)) throw new Error('recipient must be a valid email');
  if (action === 'inspect') return { action, recipient };

  const evidence: RecoveryEvidence = {
    operationId: required(values['operation-id'], 'operation-id', 36),
    expectedSuppressionRevision: positiveInteger(
      values['suppression-revision'],
      'suppression-revision',
    ),
    actorId: required(values.actor, 'actor', 128),
    reasonCode: required(values.reason, 'reason', 100),
    evidenceReference: required(values.evidence, 'evidence', 255),
    ...(values['provider-request']
      ? {
          providerRequestId: required(
            values['provider-request'],
            'provider-request',
            255,
          ),
        }
      : {}),
  };

  if (action === 'complete' && !evidence.providerRequestId) {
    throw new Error('provider-request is required for completion');
  }

  return { action, recipient, evidence };
}

function positiveInteger(value: string | undefined, name: string): number {
  const normalized = required(value, name, 10);
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(`${name} must be a positive integer`);
  }

  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} is too large`);
  }
  return parsed;
}

function required(
  value: string | undefined,
  name: string,
  maxLength: number,
): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required`);
  if (normalized.length > maxLength) throw new Error(`${name} is too long`);
  return normalized;
}
