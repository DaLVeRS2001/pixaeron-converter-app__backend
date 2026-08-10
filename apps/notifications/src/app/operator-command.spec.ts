import { ConfigModule } from '@nestjs/config';
import { MODULE_METADATA } from '@nestjs/common/constants';

import { RecipientHashService } from './delivery/recipient-hash.service';
import { EmailRecoveryService } from './operations/email-recovery.service';
import { PrismaModule } from './prisma/prisma.module';
import {
  createRecoveryCommandModule,
  parseRecoveryCommandInput,
} from './operator-command';

const args = [
  '--action=request',
  '--operation-id=0198f687-15d8-4f5e-bd79-62f8f4d51e07',
  '--suppression-revision=2',
  '--actor=support-operator',
  '--reason=OWNERSHIP_REVERIFIED',
  '--evidence=ticket-123',
];

describe('createRecoveryCommandModule', () => {
  it('boots only the database and recovery providers', () => {
    const configModule = Promise.resolve({ module: ConfigModule });
    jest.spyOn(ConfigModule, 'forRoot').mockReturnValue(configModule);
    const recoveryModule = createRecoveryCommandModule();
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      recoveryModule,
    ) as unknown[];
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      recoveryModule,
    ) as unknown[];

    expect(imports).toEqual([configModule, PrismaModule]);
    expect(providers).toEqual([RecipientHashService, EmailRecoveryService]);
  });
});

describe('parseRecoveryCommandInput', () => {
  it('parses a read-only inspection with the recipient only on stdin', () => {
    expect(
      parseRecoveryCommandInput(['--action=inspect'], ' User@Example.com\r\n'),
    ).toEqual({
      action: 'inspect',
      recipient: 'User@Example.com',
    });
  });

  it('reads the recipient from stdin instead of process arguments', () => {
    expect(parseRecoveryCommandInput(args, ' User@Example.com\r\n')).toEqual({
      action: 'request',
      recipient: 'User@Example.com',
      evidence: {
        operationId: '0198f687-15d8-4f5e-bd79-62f8f4d51e07',
        expectedSuppressionRevision: 2,
        actorId: 'support-operator',
        reasonCode: 'OWNERSHIP_REVERIFIED',
        evidenceReference: 'ticket-123',
      },
    });
  });

  it('rejects the removed recipient command-line option', () => {
    expect(() =>
      parseRecoveryCommandInput(
        [...args, '--recipient=user@example.com'],
        'user@example.com',
      ),
    ).toThrow();
  });

  it('requires a nonempty provider request for completion', () => {
    const completeArgs = args.map((argument) =>
      argument === '--action=request' ? '--action=complete' : argument,
    );

    expect(() =>
      parseRecoveryCommandInput(completeArgs, 'user@example.com'),
    ).toThrow('provider-request is required for completion');
    expect(() =>
      parseRecoveryCommandInput(
        [...completeArgs, '--provider-request=   '],
        'user@example.com',
      ),
    ).toThrow('provider-request is required');
  });
});
