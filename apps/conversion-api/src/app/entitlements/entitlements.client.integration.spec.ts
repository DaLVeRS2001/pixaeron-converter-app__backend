import {
  Server,
  ServerCredentials,
  loadPackageDefinition,
  type ServiceDefinition,
  type handleUnaryCall,
} from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {
  ClientProxyFactory,
  Transport,
  type ClientGrpc,
  type ClientProxy,
} from '@nestjs/microservices';
import {
  ENTITLEMENTS_GRPC_LOADER,
  EntitlementPlanCode,
  type GetEntitlementRequest,
  type GetEntitlementResponse,
} from '@pixaeron/entitlements-contract';
import { join } from 'node:path';

import {
  COMMAND_SECRET_METADATA_KEY,
  EntitlementsClient,
} from './entitlements.client';

const protoPath = join(
  __dirname,
  '../../../../../libs/entitlements-contract/proto/pixaeron/entitlements/v1/entitlements.proto',
);
const protoPackage = 'pixaeron.entitlements.v1';

const COMMAND_SECRET = 'entitlements-secret-for-wire-integration';

const response: GetEntitlementResponse = {
  snapshot: {
    planCode: EntitlementPlanCode.ENTITLEMENT_PLAN_CODE_ANONYMOUS,
    revision: 1,
    effectiveFromEpochMs: 1_755_000_000_000,
    maxBatchFiles: 3,
    maxFileBytes: 5242880,
    dailyFiles: 10,
    maxConcurrentFiles: 1,
    queueTier: 0,
    minStartDelayMs: 0,
    outputRetentionHours: 48,
  },
};

describe('EntitlementsClient gRPC transport', () => {
  let server: Server;
  let clientProxy: ClientProxy;
  let receivedRequest: GetEntitlementRequest | undefined;
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
        loader: { ...ENTITLEMENTS_GRPC_LOADER },
        channelOptions: { 'grpc.enable_retries': 0 },
      },
    });
    const client = new EntitlementsClient(
      clientProxy as unknown as ClientGrpc,
      {
        get: (key: string) => environment[key],
        getOrThrow: (key: string) => {
          const value = environment[key];
          if (value === undefined) {
            throw new Error(`Missing configuration value: ${key}`);
          }
          return value;
        },
      } as never,
    );
    client.onModuleInit();
    return client;
  };

  it('fetches an entitlement over a real gRPC connection', async () => {
    const port = await startServer((call, callback) => {
      receivedRequest = call.request;
      receivedSecrets = call.metadata.get(COMMAND_SECRET_METADATA_KEY);
      callback(null, response);
    });
    const client = createClient(port, {
      ENTITLEMENTS_GRPC_DEADLINE_MS: '2000',
    });

    await expect(
      client.getEntitlement({
        planCode: EntitlementPlanCode.ENTITLEMENT_PLAN_CODE_ANONYMOUS,
      }),
    ).resolves.toMatchObject(response);
    expect(receivedRequest).toMatchObject({
      planCode: EntitlementPlanCode.ENTITLEMENT_PLAN_CODE_ANONYMOUS,
    });
    expect(receivedSecrets).toEqual([]);
  });

  it('presents the command secret in metadata when configured', async () => {
    const port = await startServer((call, callback) => {
      receivedRequest = call.request;
      receivedSecrets = call.metadata.get(COMMAND_SECRET_METADATA_KEY);
      callback(null, response);
    });
    const client = createClient(port, {
      ENTITLEMENTS_GRPC_DEADLINE_MS: '2000',
      ENTITLEMENTS_COMMAND_SECRET: COMMAND_SECRET,
    });

    await expect(
      client.getEntitlement({
        subject: 'b2629a0a-4f25-405c-9767-596cbd24cb58',
      }),
    ).resolves.toMatchObject(response);
    expect(receivedRequest).toMatchObject({
      subject: 'b2629a0a-4f25-405c-9767-596cbd24cb58',
    });
    expect(receivedSecrets).toEqual([COMMAND_SECRET]);
  });

  async function startServer(
    handler: handleUnaryCall<GetEntitlementRequest, GetEntitlementResponse>,
  ): Promise<number> {
    const definition = protoLoader.loadSync(protoPath, {
      ...ENTITLEMENTS_GRPC_LOADER,
    });
    const loaded = loadEntitlementsPackage(definition);

    server = new Server();
    server.addService(loaded.EntitlementsService.service, {
      getEntitlement: handler,
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

function loadEntitlementsPackage(definition: protoLoader.PackageDefinition): {
  EntitlementsService: {
    service: ServiceDefinition;
  };
} {
  const loaded = loadPackageDefinition(definition) as unknown as {
    pixaeron: {
      entitlements: {
        v1: { EntitlementsService: { service: ServiceDefinition } };
      };
    };
  };
  return loaded.pixaeron.entitlements.v1;
}
