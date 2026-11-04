import Svg, { Path } from 'react-native-svg';
// Same 24×24 stroke icon set as the prototype (ICONS in app.html).
export const ICONS = {
  lock: 'M7 11V8a5 5 0 0110 0v3M5 11h14v10H5z', mic: 'M12 3a3 3 0 013 3v6a3 3 0 01-6 0V6a3 3 0 013-3zM5 11a7 7 0 0014 0M12 18v3',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z', clip: 'M21 12l-8.5 8.5a5 5 0 01-7-7L14 5a3.5 3.5 0 015 5l-8.5 8.5a2 2 0 01-3-3L15 8',
  cam: 'M3 7h4l2-3h6l2 3h4v13H3zM12 17a4 4 0 100-8 4 4 0 000 8z', send: 'M3 12l18-9-6 18-3-7-9-2z', qr: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3h-3zM18 18h3v3h-3z',
  moon: 'M20 14A8 8 0 1110 4a7 7 0 0010 10z', chat: 'M4 4h16v12H8l-4 4z', users: 'M9 11a4 4 0 100-8 4 4 0 000 8zM2 21a7 7 0 0114 0M17 11a3 3 0 100-6M22 21a6 6 0 00-5-6',
  gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12l2-1-2-4-2 1-2-1V5h-4v2l-2 1-2-1-2 4 2 1v2l-2 1 2 4 2-1 2 1v2h4v-2l2-1 2 1 2-4-2-1z', check: 'M4 12l5 5L20 6',
  flag: 'M5 21V4h12l-2 4 2 4H5', block: 'M12 21a9 9 0 100-18 9 9 0 000 18zM5.6 5.6l12.8 12.8', plane: 'M2 16l20-8-3-2-7 3-6-5-2 1 4 6-4 2-2-1-1 1z',
  mega: 'M3 10v4h3l8 5V5L6 10zM18 8a5 5 0 010 8', doc: 'M6 2h9l5 5v15H6zM15 2v5h5', back: 'M15 5l-7 7 7 7', x: 'M6 6l12 12M18 6L6 18',
  spk: 'M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 010 6M19 6a8 8 0 010 12', clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2',
  star: 'M12 3l3 6 6 1-4.5 4 1 6.5L12 17l-5.5 3.5 1-6.5L3 10l6-1z', shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', key: 'M14 10a4 4 0 10-1 2.7L21 21M17 17l2-2',
  play: 'M7 4l13 8-13 8z', pause: 'M7 4h3v16H7zM14 4h3v16h-3z', plus: 'M12 5v14M5 12h14', search: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3', img: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15 9a1.5 1.5 0 100-3 1.5 1.5 0 000 3',
  logout: 'M15 3h4v18h-4M10 17l5-5-5-5M15 12H3', help: 'M12 21a9 9 0 100-18 9 9 0 000 18zM9.5 9a2.5 2.5 0 015 .5c0 2-2.5 2-2.5 4M12 17v.01',
} as const;
export type IconName = keyof typeof ICONS;
export function Icon({ name, size = 20, color = '#F3EDE4', width = 1.8 }: { name: IconName; size?: number; color?: string; width?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round">
      <Path d={ICONS[name]} />
    </Svg>
  );
}
