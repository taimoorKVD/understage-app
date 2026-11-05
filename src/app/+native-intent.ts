import { normalizeUnderstageDeepLink } from '../../shared/deep-link';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return normalizeUnderstageDeepLink(path);
}
