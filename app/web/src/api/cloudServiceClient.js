(function () {
  const response = (status = 200) => ({ok: status >= 200 && status < 300, status});
  const fail = (message, status = 500) => ({
    response: response(status),
    data: {ok: false, message},
  });

  function normalizeSceneName(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/（.*?）|\(.*?\)/g, '')
      .replace(/[\s·•、,，.。:：;；'"“”‘’\-_/\\]+/g, '');
  }

  function safeFileName(value) {
    return String(value || 'image')
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N}._-]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'image';
  }

  async function uploadSceneImages(supabase, sceneKey, incoming) {
    const urls = [];
    for (const image of incoming || []) {
      if (!image?.dataUrl) continue;
      const blob = await fetch(image.dataUrl).then((result) => result.blob());
      const key = `scenes/${sceneKey}/${crypto.randomUUID()}-${safeFileName(image.name)}`;
      const {error} = await supabase.storage
        .from('scene-images')
        .upload(key, blob, {contentType: blob.type || 'image/jpeg', upsert: false});
      if (error) throw error;
      const {data} = supabase.storage.from('scene-images').getPublicUrl(key);
      if (data?.publicUrl) urls.push(data.publicUrl);
    }
    return urls;
  }

  function create(runtime) {
    const supabase = runtime.supabase;
    const userId = runtime.user?.id;
    const capabilities = {
      mode: 'cloud',
      cloudRoutes: true,
      sharedScenes: true,
      serverExport: false,
      editableMapConfig: false,
    };

    return {
      capabilities,
      routeAssetBase() {
        return '';
      },
      async health() {
        return {response: response(), data: {ok: true, mode: 'cloud'}};
      },
      async getConfig() {
        return {
          response: response(),
          data: {
            ok: true,
            key: runtime.config.amapKey,
            securityJsCode: runtime.config.amapSecurityJsCode,
            configured: Boolean(runtime.config.amapKey && runtime.config.amapSecurityJsCode),
            source: 'EdgeOne environment variables',
          },
        };
      },
      async saveConfig() {
        return fail('网站地图配置由 EdgeOne 环境变量统一管理。', 403);
      },
      async listRoutes() {
        const {data, error} = await supabase
          .from('routes')
          .select('id,name,route_data,map_layer,created_at,updated_at')
          .order('updated_at', {ascending: false});
        if (error) return fail(error.message);
        const routes = (data || []).map((item) => ({
          name: item.name,
          safeName: item.id,
          fileBase: item.id,
          archivedAt: item.created_at,
          updatedAt: item.updated_at,
          mapLayer: item.map_layer,
          routeJson: true,
          videoJson: false,
          mp4: false,
          manualMd: false,
          manualPdf: false,
          cloud: true,
          routeData: item.route_data,
        }));
        return {response: response(), data: {ok: true, routes}};
      },
      async saveRoute(routeData, mapLayer) {
        if (!userId) return fail('登录状态已失效，请重新登录。', 401);
        const payload = {
          id: routeData.id,
          user_id: userId,
          name: routeData.name || '未命名路线',
          route_data: routeData,
          map_layer: mapLayer || 'standard',
          updated_at: new Date().toISOString(),
        };
        const {data, error} = await supabase
          .from('routes')
          .upsert(payload, {onConflict: 'user_id,id'})
          .select('id,updated_at')
          .single();
        if (error) return fail(error.message);
        return {response: response(), data: {ok: true, route: data}};
      },
      async deleteRoute(routeId) {
        const {error} = await supabase.from('routes').delete().eq('id', routeId).eq('user_id', userId);
        if (error) return fail(error.message);
        return {response: response(), data: {ok: true}};
      },
      async getScenic(name) {
        const normalized = normalizeSceneName(name);
        if (!normalized) return fail('景点名称不能为空。', 400);
        const {data, error} = await supabase
          .from('scenes')
          .select('id,name,title,description,images,updated_at')
          .eq('normalized_name', normalized)
          .maybeSingle();
        if (error) return fail(error.message);
        return {
          response: response(),
          data: {
            ok: true,
            spot: data ? {
              id: data.id,
              name: data.name,
              title: data.title,
              description: data.description,
              images: data.images || [],
              updatedAt: data.updated_at,
            } : null,
          },
        };
      },
      async saveScenic(payload) {
        if (!userId) return fail('登录状态已失效，请重新登录。', 401);
        const name = String(payload.name || payload.title || '').trim();
        const normalized = normalizeSceneName(name);
        if (!normalized) return fail('景点名称不能为空。', 400);

        const {data: existing, error: readError} = await supabase
          .from('scenes')
          .select('id,name,title,description,images')
          .eq('normalized_name', normalized)
          .maybeSingle();
        if (readError) return fail(readError.message);

        try {
          const uploaded = await uploadSceneImages(supabase, normalized, payload.images);
          const images = [...new Set([...(existing?.images || []), ...uploaded])];
          const next = {
            ...(existing?.id ? {id: existing.id} : {}),
            normalized_name: normalized,
            name,
            title: String(payload.title || existing?.title || name).trim(),
            description: String(payload.description || existing?.description || '').trim(),
            images,
            updated_by: userId,
            updated_at: new Date().toISOString(),
          };
          const {data: scene, error: writeError} = await supabase
            .from('scenes')
            .upsert(next, {onConflict: 'normalized_name'})
            .select('id,name,title,description,images,updated_at')
            .single();
          if (writeError) return fail(writeError.message);

          const {error: revisionError} = await supabase.from('scene_revisions').insert({
            scene_id: scene.id,
            editor_user_id: userId,
            old_data: existing || null,
            new_data: scene,
          });
          if (revisionError) console.warn('Scene revision was not recorded:', revisionError.message);

          return {
            response: response(),
            data: {
              ok: true,
              folderName: normalized,
              spot: {
                id: scene.id,
                name: scene.name,
                title: scene.title,
                description: scene.description,
                images: scene.images || [],
                updatedAt: scene.updated_at,
              },
            },
          };
        } catch (error) {
          return fail(error.message);
        }
      },
      async exportRoute() {
        return fail('网站版使用浏览器下载；PDF 和视频请使用本地高级版。', 501);
      },
      async getExportProgress() {
        return {response: response(), data: {ok: true, rendering: false, progress: null}};
      },
      async cancelExport() {
        return {response: response(), data: {ok: true, cancelled: false}};
      },
    };
  }

  window.CloudServiceClient = {create};
})();
