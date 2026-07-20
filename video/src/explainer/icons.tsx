export const ICON_PATHS = {
  // Baseball infield diamond, viewBox 0 0 100 100
  diamond: 'M50 10 L90 50 L50 90 L10 50 Z',
  // Simple flame silhouette, viewBox 0 0 100 100
  flame:
    'M50 6 C34 26 26 40 26 60 C26 79 37 92 50 92 C63 92 74 79 74 60 C74 47 67 40 61 46 C61 32 53 18 50 6 Z',
  // 5-point star, viewBox 0 0 100 100
  star: 'M50 6 L61 36 L94 36 L67 55 L78 88 L50 68 L22 88 L33 55 L6 36 L39 36 Z',
  // Funnel, viewBox 0 0 100 100
  funnel: 'M8 14 L92 14 L58 54 L58 88 L42 88 L42 54 Z',
  // Home-run trajectory arc, viewBox 0 0 200 120
  arc: 'M10 110 C 60 -10, 140 -10, 190 110',
} as const;

export const HomePlate: React.FC<{ size?: number; fill: string }> = ({ size = 40, fill }) => (
  <svg width={size} height={size} viewBox="0 0 100 100">
    <path d="M10 10 L70 10 L92 40 L50 90 L8 40 Z" fill={fill} />
  </svg>
);
