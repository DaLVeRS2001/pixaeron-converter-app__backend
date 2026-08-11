const SENDER_ADDRESS_PATTERN = /^(?:[^<>\r\n]*<([^<>\r\n]+)>|([^<>\r\n]+))$/;

export function parseSenderAddress(value: string): string | null {
  const match = SENDER_ADDRESS_PATTERN.exec(value);
  const address = match?.[1] ?? match?.[2];

  return address ? address.trim() : null;
}
