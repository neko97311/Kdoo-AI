import KdooSignatureModule from './src/KdooSignatureModule';

export function getSignatureSha1(): string {
  return KdooSignatureModule.getSha1();
}