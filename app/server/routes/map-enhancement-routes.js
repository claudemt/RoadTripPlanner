const HILLSHADE_PATH = /^\/api\/map\/hillshade\/(\d+)\/(-?\d+)\/(-?\d+)\.webp$/;

const createMapEnhancementRoutes = ({pointInfoService, hillshadeService, readBody, send}) => {
  if (!pointInfoService || !hillshadeService || !readBody || !send) {
    throw new Error('地图增强路由缺少依赖。');
  }

  return async function handleMapEnhancementRoute(req, res, url) {
    if (req.method === 'POST' && url.pathname === '/api/point-info') {
      try {
        const payload = await readBody(req, 2 * 1024 * 1024);
        send(res, 200, await pointInfoService.getPointInfo(payload));
      } catch (error) {
        send(res, Number(error.status) || 502, {ok: false, message: error.message || '点位信息暂时不可用。'});
      }
      return true;
    }

    const hillshadeMatch = req.method === 'GET' ? url.pathname.match(HILLSHADE_PATH) : null;
    if (!hillshadeMatch) return false;
    const tile = await hillshadeService.getTile(hillshadeMatch[1], hillshadeMatch[2], hillshadeMatch[3]);
    res.writeHead(200, {
      'Content-Type': 'image/webp',
      'Content-Length': tile.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    res.end(tile);
    return true;
  };
};

module.exports = {createMapEnhancementRoutes};
