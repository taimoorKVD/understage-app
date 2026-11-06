/** CURTAIN — Design 1 tokens. Existing keys are preserved so screens keep compiling. */
export const C = {
  bg: '#0B0A0C',
  bgPlum: '#140C14',
  card: '#161018',
  input: '#201820',
  border: 'rgba(216,178,106,0.16)',
  border2: 'rgba(216,178,106,0.32)',
  gold: '#D8B26A',
  goldText: '#1a1208',
  goldSoft: 'rgba(216,178,106,0.16)',
  goldGlow: 'rgba(216,178,106,0.55)',
  red: '#B3263E',
  green: '#3FB27F',
  muted: '#9A8F99',
  text: '#F3EDE4',
  sent: '#D8B26A',
  recv: 'rgba(28,22,34,0.92)',
  track: '#2c2332',
  pill: 'rgba(216,178,106,0.14)',
  greenPill: 'rgba(63,178,127,0.15)',
  violet: '#b9b2ff',
  readBlue: '#7fc4ff',
  tm: '#c9b8c0',
  segOn: '#3a2c30',
  dangerCard: '#24121a',
  goldCard: '#2a1d12',
  white: '#fff',
  glass: 'rgba(22,16,26,0.82)',
} as const;

export const G = {
  gold: ['#F0D59A', '#D8B26A', '#B89543'] as const,
  sent: ['#E9CB8E', '#D8B26A'] as const,
  page: ['#3a1420', '#160A12', '#0B0A0C'] as const,
  hero: ['#5c1428', '#2a0c18', '#12080e'] as const,
  welcome: ['#3a1420', '#0B0A0C'] as const,
  dock: ['rgba(22,16,26,0.92)', 'rgba(14,10,16,0.96)'] as const,
};

export const AVC = ['#B3263E', '#D8B26A', '#5B8DEF', '#3FB27F', '#9B5DE5', '#E07A5F', '#2EC4B6'];
export const F = {
  serif: 'PlayfairDisplay_600SemiBold', serifBold: 'PlayfairDisplay_700Bold',
  regular: 'Inter_400Regular', medium: 'Inter_500Medium', semibold: 'Inter_600SemiBold', bold: 'Inter_700Bold', heavy: 'Inter_800ExtraBold', light: 'Inter_300Light',
};
export const R = { card: 20, btn: 16, inp: 16, pill: 20 };
export const S = { pad: 18, gap: 12 };
/** Space reserved above the floating Stage Dock (tab screens). */
export const DOCK_SPACE = 108;
