import * as ExpoCrypto from 'expo-crypto';
import { setRandomSource } from '../../shared/e2ee';
// tweetnacl needs a CSPRNG; on React Native we feed it from the OS (SecRandomCopyBytes on iOS) via expo-crypto.
setRandomSource(n => ExpoCrypto.getRandomBytes(n));
export * from '../../shared/e2ee';
export const randomId = () => ExpoCrypto.randomUUID();
