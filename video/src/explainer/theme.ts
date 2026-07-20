import { cancelRender, continueRender, delayRender, staticFile } from 'remotion';

// Self-hosted (not @remotion/google-fonts) so rendering never depends on
// reaching fonts.gstatic.com at render time — see video/public/fonts/.
export const FONT_FAMILY = 'Inter Explainer';

const FONT_FACES = [
  { weight: 400, file: 'Inter-Regular.otf' },
  { weight: 600, file: 'Inter-SemiBold.otf' },
  { weight: 800, file: 'Inter-ExtraBold.otf' },
];

if (typeof document !== 'undefined') {
  const handle = delayRender('Loading self-hosted Inter font faces');
  Promise.all(
    FONT_FACES.map(({ weight, file }) => {
      const face = new FontFace(FONT_FAMILY, `url(${staticFile(`fonts/${file}`)})`, {
        weight: String(weight),
      });
      return face.load().then((loaded) => {
        (document.fonts as FontFaceSet).add(loaded);
      });
    }),
  )
    .then(() => continueRender(handle))
    .catch((err) => cancelRender(err));
}

export const COLORS = {
  bgTop: '#070c14',
  bgBottom: '#0d1a2b',
  text: '#ffffff',
  accent: '#22c55e',
  dim: 'rgba(255,255,255,0.6)',
  faint: 'rgba(255,255,255,0.12)',
};

// Platform-UI safe zone, per spec: 150px top, 170px bottom, 60px sides.
export const SAFE = {
  top: 150,
  bottom: 170,
  side: 60,
};

// Absolute mobile-readability floors from spec — never go below these.
export const FONT_SIZE = {
  headline: 60,
  body: 38,
  label: 30,
};

export const SPRING_CONFIG = { damping: 200 };
