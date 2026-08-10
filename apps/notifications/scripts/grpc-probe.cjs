const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const [, , mode, target, protoPath] = process.argv;

if (
  !['invalid-command', 'unreachable'].includes(mode) ||
  !target ||
  !protoPath
) {
  console.error(
    'Usage: node grpc-probe.cjs <invalid-command|unreachable> <host:port> <proto-path>',
  );
  process.exit(2);
}

const packageDefinition = protoLoader.loadSync(protoPath, {
  defaults: true,
  enums: Number,
  longs: String,
  oneofs: true,
});
const loaded = grpc.loadPackageDefinition(packageDefinition);
const NotificationsEmailService =
  loaded.pixaeron.notifications.v1.NotificationsEmailService;
const client = new NotificationsEmailService(
  target,
  grpc.credentials.createInsecure(),
);
const deadline = Date.now() + 5_000;

if (mode === 'unreachable') {
  client.waitForReady(deadline, (error) => {
    client.close();
    if (!error) {
      console.error(`Unexpectedly reached Notifications gRPC at ${target}.`);
      process.exit(1);
    }

    console.log(
      `Notifications gRPC is unreachable from ${target}, as expected.`,
    );
  });
} else {
  client.sendSecurityEmail(
    {
      requestId: 'invalid-request-id',
      publicSubject: 'invalid-public-subject',
      recipient: 'invalid-recipient',
      purpose: 0,
      token: '',
      contentVersion: 0,
    },
    { deadline },
    (error) => {
      client.close();
      if (error?.code !== grpc.status.INVALID_ARGUMENT) {
        console.error(
          `Expected INVALID_ARGUMENT from Notifications gRPC, received ${error?.code ?? 'success'}.`,
        );
        process.exit(1);
      }

      console.log(
        'Notifications gRPC accepted the wire request and rejected its invalid payload.',
      );
    },
  );
}
