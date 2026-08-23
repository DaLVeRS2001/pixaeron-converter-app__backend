import type { ConfigService } from '@nestjs/config';

type ExplicitAwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
};

export const explicitAwsCredentials = (
  configService: ConfigService,
): ExplicitAwsCredentials | undefined => {
  const accessKeyId = configService.get<string>('AWS_ACCESS_KEY_ID');
  if (!accessKeyId) return undefined;

  return {
    accessKeyId,
    secretAccessKey: configService.getOrThrow<string>('AWS_SECRET_ACCESS_KEY'),
  };
};
