// Small continuous ambient motion so scenes never sit fully still between
// spring entrances — additive, not a replacement for the spring animations.
export const idleBob = (frame: number, amplitude = 5, speed = 0.12, phase = 0) =>
  Math.sin(frame * speed + phase) * amplitude;

export const idlePulse = (frame: number, amplitude = 0.05, speed = 0.1, phase = 0) =>
  1 + Math.sin(frame * speed + phase) * amplitude;
