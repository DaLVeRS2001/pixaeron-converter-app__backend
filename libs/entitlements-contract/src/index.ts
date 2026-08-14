export * from './generated/pixaeron/entitlements/v1/entitlements';

export const COMMAND_SECRET_METADATA_KEY = 'x-pixaeron-command-secret';

export const ENTITLEMENTS_GRPC_LOADER = {
  defaults: true,
  longs: Number,
  oneofs: true,
} as const;
