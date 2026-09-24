const fs = require('node:fs');
const path = require('node:path');

const dataDir = path.join(
  __dirname,
  '..',
  'video',
  'src',
  'projects',
  'amap-route-video',
  'data',
);
const runtimeData = path.join(dataDir, 'route-video-data.json');
const exampleData = path.join(dataDir, 'route-video-data.example.json');

if (!fs.existsSync(runtimeData)) {
  fs.copyFileSync(exampleData, runtimeData);
  console.log('Created the default Remotion route data file.');
}
