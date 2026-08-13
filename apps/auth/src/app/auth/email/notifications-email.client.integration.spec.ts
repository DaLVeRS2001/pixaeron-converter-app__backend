import {
  Server,
  ServerCredentials,
  loadPackageDefinition,
  type handleUnaryCall,
  type ServiceDefinition,
} from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {
  ClientProxyFactory,
  Transport,
  type ClientGrpc,
  type ClientProxy,
} from '@nestjs/microservices';
import {
  SecurityEmailPurpose,
  SendSecurityEmailResult,
  type SendSecurityEmailRequest,
  type SendSecurityEmailResponse,
} from '@pixaeron/notifications-contract';
import { join } from 'node:path';

import {
  COMMAND_SECRET_METADATA_KEY,
  NotificationsEmailClient,
} from './notifications-email.client';

const protoPath = join(
  __dirname,
  '../../../../../../libs/notifications-contract/proto/pixaeron/notifications/v1/notifications.proto',
);
const protoPackage = 'pixaeron.notifications.v1';

const COMMAND_SECRET = 'integration-command-secret-for-wire-tests';

describe('NotificationsEmailClient gRPC transport', () => {
  let server: Server;
  let clientProxy: ClientProxy;
  let receivedRequest: SendSecurityEmailRequest | undefined;
  let receivedSecrets: Array<string | Buffer> | undefined;

  beforeEach(() => {
    receivedRequest = undefined;
    receivedSecrets = undefined;
  });

  afterEach(async () => {
    clientProxy?.close();
    if (server) {
      await new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
    }
  });

  const createClient = (port: number, environment: Record<string, string>) => {
    clientProxy = ClientProxyFactory.create({
      transport: Transport.GRPC,
      options: {
        package: protoPackage,
        protoPath,
        url: `127.0.0.1:${port}`,
        channelOptions: { 'grpc.enable_retries': 0 },
      },
    });
    const client = new NotificationsEmailClient(
      clientProxy as unknown as ClientGrpc,
      {
        get: (key: string) => environment[key],
      } as never,
    );
    client.onModuleInit();
    return client;
  };

  const request: SendSecurityEmailRequest = {
    requestId: 'b2629a0a-4f25-405c-9767-596cbd24cb58',
    publicSubject: '0198f687-15d8-7f5e-bd79-62f8f4d51e08',
    recipient: 'user@example.com',
    purpose: SecurityEmailPurpose.SECURITY_EMAIL_PURPOSE_EMAIL_VERIFICATION,
    token: 'raw-token',
    contentVersion: 1,
  };

  it('sends the generated command over a real gRPC connection', async () => {
    const port = await startServer((call, callback) => {
      receivedRequest = call.request;
      receivedSecrets = call.metadata.get(COMMAND_SECRET_METADATA_KEY);
      callback(null, {
        result: SendSecurityEmailResult.SEND_SECURITY_EMAIL_RESULT_ACCEPTED,
      });
    });
    const client = createClient(port, {
      NOTIFICATIONS_GRPC_DEADLINE_MS: '2000',
    });

    await expect(client.sendSecurityEmail(request)).resolves.toEqual({
      result: SendSecurityEmailResult.SEND_SECURITY_EMAIL_RESULT_ACCEPTED,
    });
    expect(receivedRequest).toEqual(request);
    expect(receivedSecrets).toEqual([]);
  });

  it('presents the command secret in metadata when configured', async () => {
    const port = await startServer((call, callback) => {
      receivedRequest = call.request;
      receivedSecrets = call.metadata.get(COMMAND_SECRET_METADATA_KEY);
      callback(null, {
        result: SendSecurityEmailResult.SEND_SECURITY_EMAIL_RESULT_ACCEPTED,
      });
    });
    const client = createClient(port, {
      NOTIFICATIONS_GRPC_DEADLINE_MS: '2000',
      NOTIFICATIONS_COMMAND_SECRET: COMMAND_SECRET,
    });

    await expect(client.sendSecurityEmail(request)).resolves.toEqual({
      result: SendSecurityEmailResult.SEND_SECURITY_EMAIL_RESULT_ACCEPTED,
    });
    expect(receivedRequest).toEqual(request);
    expect(receivedSecrets).toEqual([COMMAND_SECRET]);
  });

  async function startServer(
    handler: handleUnaryCall<
      SendSecurityEmailRequest,
      SendSecurityEmailResponse
    >,
  ): Promise<number> {
    const definition = protoLoader.loadSync(protoPath, {
      defaults: true,
      enums: Number,
      longs: String,
      oneofs: true,
    });
    const loaded = loadNotificationsPackage(definition);

    server = new Server();
    server.addService(loaded.NotificationsEmailService.service, {
      sendSecurityEmail: handler,
    });

    return new Promise<number>((resolve, reject) => {
      server.bindAsync(
        '127.0.0.1:0',
        ServerCredentials.createInsecure(),
        (error, port) => {
          if (error) reject(error);
          else resolve(port);
        },
      );
    });
  }
});

function loadNotificationsPackage(definition: protoLoader.PackageDefinition): {
  NotificationsEmailService: {
    service: ServiceDefinition;
  };
} {
  const loaded = loadPackageDefinition(definition) as unknown as {
    pixaeron: {
      notifications: {
        v1: { NotificationsEmailService: { service: ServiceDefinition } };
      };
    };
  };
  return loaded.pixaeron.notifications.v1;
}
