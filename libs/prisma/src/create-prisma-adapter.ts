import { PrismaPg } from '@prisma/adapter-pg';

export function createPrismaPgAdapter(connectionString: string) {
  return new PrismaPg({ connectionString });
}
