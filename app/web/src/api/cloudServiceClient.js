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
    const isAdmin = String(runtime.user?.email || '').toLowerCase() === 'admin@map.bestapi.best';
    const capabilities = {
      mode: 'cloud',
      cloudRoutes: true,
      sharedScenes: true,
      serverExport: true,
      cloudExports: true,
      editableMapConfig: isAdmin,
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
        const {data, error} = await supabase
          .from('app_settings')
          .select('value')
          .eq('key', 'amap')
          .maybeSingle();
        if (error) return fail(error.message);
        const saved = data?.value || {};
        const key = String(saved.key || runtime.config.amapKey || '').trim();
        const securityJsCode = String(saved.securityJsCode || runtime.config.amapSecurityJsCode || '').trim();
        return {
          response: response(),
          data: {
            ok: true,
            key,
            securityJsCode,
            configured: Boolean(key && securityJsCode),
            editable: isAdmin,
            source: data?.value ? 'Supabase app_settings' : 'EdgeOne environment variables',
          },
        };
      },
      async saveConfig(payload) {
        if (!isAdmin) return fail('只有管理员可以修改地图配置。', 403);
        const key = String(payload?.key || '').trim();
        const securityJsCode = String(payload?.securityJsCode || '').trim();
        if (!key || !securityJsCode) return fail('请填写 Key 和安全密钥。', 400);
        const {error} = await supabase
          .from('app_settings')
          .upsert({
            key: 'amap',
            value: {key, securityJsCode},
            updated_by: userId,
            updated_at: new Date().toISOString(),
          }, {onConflict: 'key'});
        if (error) return fail(error.message);
        return {response: response(), data: {ok: true, source: 'Supabase app_settings'}};
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
      async listExports() {
        const {data, error} = await supabase
          .from('export_jobs')
          .select('id,route_id,route_name,render_video,status,phase,message,progress,artifacts,error,created_at,started_at,completed_at,updated_at')
          .order('created_at', {ascending: false});
        if (error) return fail(error.message);
        return {response: response(), data: {ok: true, exports: data || []}};
      },
      async exportRoute(payload) {
        if (!userId) return fail('登录状态已失效，请重新登录。', 401);
        const routeData = payload?.routeData || payload?.route;
        if (!routeData?.id) return fail('缺少路线数据。', 400);
        const requestPayload = {
          routeData,
          videoData: payload?.videoData || null,
          renderVideo: payload?.renderVideo === true,
          mapLayer: payload?.mapLayer || 'standard',
        };
        const {data, error} = await supabase
          .from('export_jobs')
          .insert({
            user_id: userId,
            route_id: routeData.id,
            route_name: routeData.name || '未命名路线',
            render_video: requestPayload.renderVideo,
            request_payload: requestPayload,
          })
          .select('id,route_id,route_name,render_video,status,phase,message,progress,created_at')
          .single();
        if (error) return fail(error.message);
        return {response: response(202), data: {ok: true, queued: true, job: data}};
      },
      async getExportProgress() {
        const {data, error} = await supabase
          .from('export_jobs')
          .select('id,status,phase,message,progress,error,created_at,updated_at')
          .in('status', ['queued', 'running', 'cancel_requested'])
          .order('created_at', {ascending: false})
          .limit(1)
          .maybeSingle();
        if (error) return fail(error.message);
        if (!data) return {response: response(), data: {ok: true, rendering: false, progress: null}};
        return {
          response: response(),
          data: {
            ok: true,
            rendering: true,
            exportTaskId: data.id,
            progress: {
              active: true,
              done: false,
              phase: data.phase,
              message: data.message,
              percent: data.progress,
              error: data.error,
              updatedAt: data.updated_at,
            },
          },
        };
      },
      async cancelExport() {
        const {data: active, error: readError} = await supabase
          .from('export_jobs')
          .select('id,status')
          .in('status', ['queued', 'running', 'cancel_requested'])
          .order('created_at', {ascending: false})
          .limit(1)
          .maybeSingle();
        if (readError) return fail(readError.message);
        if (!active) return {response: response(), data: {ok: true, cancelled: false}};
        if (active.status === 'cancel_requested') {
          return {response: response(), data: {ok: true, cancelled: true}};
        }
        const {data: cancelled, error} = await supabase.rpc('request_export_cancel', {p_job_id: active.id});
        if (error) return fail(error.message);
        return {response: response(), data: {ok: true, cancelled: Boolean(cancelled)}};
      },
      async getExportArtifactUrl(objectPath, expiresIn = 3600) {
        const {data, error} = await supabase.storage
          .from('route-exports')
          .createSignedUrl(objectPath, expiresIn, {download: false});
        if (error) return fail(error.message);
        return {response: response(), data: {ok: true, url: data.signedUrl}};
      },
    };
  }

  window.CloudServiceClient = {create};
})();
