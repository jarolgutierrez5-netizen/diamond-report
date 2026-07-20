import { Config } from '@remotion/cli/config';

// Reuse the Chromium already bundled for Playwright instead of letting
// Remotion download its own copy on first render.
Config.setBrowserExecutable(
  '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
);
Config.setVideoImageFormat('jpeg');
