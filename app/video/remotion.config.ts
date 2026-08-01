import {Config} from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setConcurrency(1);
Config.setChromiumDisableWebSecurity(false);
Config.setOverwriteOutput(true);

if (process.env.REMOTION_PUBLIC_DIR) {
  Config.setPublicDir(process.env.REMOTION_PUBLIC_DIR);
}
