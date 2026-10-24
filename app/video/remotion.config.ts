import {Config} from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setConcurrency(1);
Config.setChromiumDisableWebSecurity(false);
Config.setOverwriteOutput(true);

if (process.env.REMOTION_PUBLIC_DIR) {
  Config.setPublicDir(process.env.REMOTION_PUBLIC_DIR);
}

// Bound x264 memory use on machines reporting many CPU cores.
Config.overrideFfmpegCommand(({args}) => [...args.slice(0, -1), '-threads', '2', args[args.length - 1]]);
