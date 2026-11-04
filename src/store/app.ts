import { create } from 'zustand';
import type { Identity } from '../../shared/e2ee';
import type { Conversation, SelfUser, Workspace } from '../lib/types';
import type { LocalMessage } from '../lib/db';

export type AuthStatus = 'loading' | 'signedOut' | 'onboarding' | 'ready';
export interface Toast { id: number; text: string }
export interface BannerT { id: number; title: string; body: string; icon?: 'moon' | 'plane' | 'chat' | 'mega' | 'phone' | 'star' | 'clock'; onPress?: () => void }

interface State {
  status: AuthStatus; me: SelfUser | null; identity: Identity | null;
  online: boolean; socketConnected: boolean;
  conversations: Record<string, Conversation>; convOrder: string[];
  messages: Record<string, LocalMessage[]>;
  typing: Record<string, { userId: string; until: number }[]>;
  workspaces: Workspace[]; contactsVersion: number; heldCount: number;
  toast: Toast | null; banner: BannerT | null; offShiftDismissed: boolean;
  set: (p: Partial<State>) => void;
  showToast: (text: string) => void;
  showBanner: (b: Omit<BannerT, 'id'>) => void;
}
let tid = 0;
export const useApp = create<State>(set => ({
  status: 'loading', me: null, identity: null, online: true, socketConnected: false,
  conversations: {}, convOrder: [], messages: {}, typing: {}, workspaces: [], contactsVersion: 0, heldCount: 0,
  toast: null, banner: null, offShiftDismissed: false,
  set: p => set(p),
  showToast: text => { const id = ++tid; set({ toast: { id, text } }); setTimeout(() => set(s => (s.toast?.id === id ? { toast: null } : {})), 2600); },
  showBanner: b => { const id = ++tid; set({ banner: { ...b, id } }); setTimeout(() => set(s => (s.banner?.id === id ? { banner: null } : {})), 6000); },
}));
export const toast = (t: string) => useApp.getState().showToast(t);
