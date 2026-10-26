import {useEffect, useState} from 'react';
import {cancelRender, continueRender, delayRender, staticFile} from 'remotion';

export const routeFont = '"RoadTrip Noto Sans SC", "Microsoft YaHei", "PingFang SC", sans-serif';
let loading: Promise<FontFace> | null = null;

export const useRouteFont = () => {
  const [handle] = useState(() => delayRender('Loading route font'));
  useEffect(() => {
    loading ||= new FontFace('RoadTrip Noto Sans SC', `url(${staticFile('fonts/NotoSansSC-Regular.otf')})`).load().then((face) => {
      document.fonts.add(face);
      return face;
    });
    loading.then(() => continueRender(handle)).catch((error) => cancelRender(error));
  }, [handle]);
};
