import { requireNativeModule } from 'expo-modules-core';

export type MlsAddMemberResult = {
  commit: string;
  welcome: string;
  epoch: number;
};

export type MlsRemoveMemberResult = {
  commit: string;
  epoch: number;
};

export type MlsProcessResult = {
  kind: string;
  plaintext: string | null;
  epoch: number;
};

export type UnderstageMlsNative = {
  isAvailable(): boolean;
  ciphersuiteName(): string;
  documentsDirectory(): string;
  openSession(storagePath: string): Promise<string>;
  closeSession(sessionId: string): Promise<void>;
  generateCredential(sessionId: string, identity: string): Promise<void>;
  exportKeyPackage(sessionId: string): Promise<string>;
  createGroup(sessionId: string): Promise<string>;
  addMember(sessionId: string, keyPackageB64: string): Promise<MlsAddMemberResult>;
  joinFromWelcome(sessionId: string, welcomeB64: string): Promise<number>;
  processIncoming(sessionId: string, messageB64: string): Promise<MlsProcessResult>;
  encrypt(sessionId: string, plaintext: string): Promise<string>;
  decrypt(sessionId: string, ciphertextB64: string): Promise<string>;
  removeMember(sessionId: string, identity: string): Promise<MlsRemoveMemberResult>;
  epoch(sessionId: string): Promise<number>;
};

export default requireNativeModule<UnderstageMlsNative>('UnderstageMls');
