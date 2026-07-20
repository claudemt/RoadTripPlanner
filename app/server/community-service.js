const crypto = require('crypto');
const path = require('path');

const PROFILE_AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const MESSAGE_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
const MESSAGE_ATTACHMENTS_MAX_BYTES = 50 * 1024 * 1024;
const MESSAGE_ATTACHMENT_LIMIT = 4;

const safeFileName = (value, fallback = 'file') =>
  String(value || fallback)
    .normalize('NFKC')
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || fallback;

const extensionFor = (fileName, contentType) => {
  const source = path.extname(String(fileName || '')).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(source)) return source;
  if (/png/i.test(contentType)) return '.png';
  if (/jpe?g/i.test(contentType)) return '.jpg';
  if (/webp/i.test(contentType)) return '.webp';
  if (/gif/i.test(contentType)) return '.gif';
  if (/pdf/i.test(contentType)) return '.pdf';
  if (/zip/i.test(contentType)) return '.zip';
  return '.bin';
};

const parseDataUrl = (file) => {
  const match = String(file?.dataUrl || '').match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) throw new Error('附件数据格式无效。');
  return {
    buffer: Buffer.from(match[2], 'base64'),
    contentType: String(file?.type || match[1] || 'application/octet-stream').slice(0, 120),
    fileName: safeFileName(file?.name),
  };
};

const isDescriptor = (value) =>
  value && typeof value === 'object' && typeof value.storageBucket === 'string' && typeof value.storagePath === 'string';

function createCommunityService({
  getSupabase,
  getStorageUserId,
  normalizeEmail,
  isAdmin,
  bucket = 'roadtrip-community-private',
  signedUrlSeconds = 7200,
}) {
  const defaultNickname = (email) => String(email || '').split('@')[0].slice(0, 40) || '旅人';

  const uploadObject = async ({storagePath, buffer, contentType, fileName}) => {
    const supabase = getSupabase();
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const {error} = await supabase.storage.from(bucket).upload(storagePath, buffer, {
      contentType,
      cacheControl: '31536000',
      upsert: false,
    });
    if (error && !/exist|duplicate|already/i.test(error.message || '')) throw error;
    return {
      storageBucket: bucket,
      storagePath,
      sha256,
      size: buffer.length,
      contentType,
      fileName,
    };
  };

  const removeDescriptors = async (descriptors) => {
    const paths = (descriptors || []).filter(isDescriptor).map((item) => item.storagePath);
    if (!paths.length) return;
    await getSupabase().storage.from(bucket).remove([...new Set(paths)]).catch(() => {});
  };

  const signedUrl = async (descriptor) => {
    if (!isDescriptor(descriptor) || descriptor.storageBucket !== bucket) return null;
    const {data, error} = await getSupabase().storage
      .from(bucket)
      .createSignedUrl(descriptor.storagePath, signedUrlSeconds);
    if (error) throw error;
    return data?.signedUrl || null;
  };

  const ensureProfileRow = async (email) => {
    const supabase = getSupabase();
    const {data: existing, error: readError} = await supabase
      .from('roadtrip_profiles')
      .select('owner_email,nickname,bio,avatar,created_at,updated_at')
      .eq('owner_email', email)
      .maybeSingle();
    if (readError) throw readError;
    if (existing) return existing;
    const row = {owner_email: email, nickname: defaultNickname(email), bio: ''};
    const {data, error} = await supabase
      .from('roadtrip_profiles')
      .insert(row)
      .select('owner_email,nickname,bio,avatar,created_at,updated_at')
      .single();
    if (!error) return data;
    const {data: raced, error: retryError} = await supabase
      .from('roadtrip_profiles')
      .select('owner_email,nickname,bio,avatar,created_at,updated_at')
      .eq('owner_email', email)
      .single();
    if (retryError) throw error;
    return raced;
  };

  const serializeProfile = async (email, row = null) => {
    const admin = isAdmin({email});
    if (admin) {
      return {
        email,
        nickname: 'admin',
        bio: '',
        avatarUrl: null,
        avatarKind: 'admin',
        isAdmin: true,
        updatedAt: row?.updated_at || null,
      };
    }
    const profile = row || await ensureProfileRow(email);
    return {
      email,
      nickname: profile?.nickname || defaultNickname(email),
      bio: profile?.bio || '',
      avatarUrl: await signedUrl(profile?.avatar),
      avatarKind: profile?.avatar ? 'custom' : 'default',
      isAdmin: false,
      updatedAt: profile?.updated_at || null,
    };
  };

  const getContributions = async (email) => {
    const supabase = getSupabase();
    const [routes, scenes] = await Promise.all([
      supabase
        .from('roadtrip_published_routes')
        .select('id,name,published_at', {count: 'exact'})
        .eq('published_by_email', email)
        .order('published_at', {ascending: false})
        .limit(30),
      supabase
        .from('roadtrip_scene_revisions')
        .select('id,name,title,version,change_note,created_at', {count: 'exact'})
        .eq('edited_by_email', email)
        .order('created_at', {ascending: false})
        .limit(40),
    ]);
    if (routes.error) throw routes.error;
    if (scenes.error) throw scenes.error;
    return {
      routeCount: routes.count || 0,
      sceneRevisionCount: scenes.count || 0,
      routes: routes.data || [],
      scenes: scenes.data || [],
    };
  };

  const getProfile = async (requestedEmail, identity) => {
    const email = normalizeEmail(requestedEmail || identity?.email);
    if (!email) {
      const error = new Error('用户邮箱无效。');
      error.status = 400;
      throw error;
    }
    const row = isAdmin({email}) ? null : await ensureProfileRow(email);
    return {
      ok: true,
      profile: await serializeProfile(email, row),
      contributions: await getContributions(email),
      editable: email === identity?.email && !isAdmin(identity),
    };
  };

  const saveProfile = async (payload, identity) => {
    const email = normalizeEmail(identity?.email);
    if (!email) throw new Error('缺少用户邮箱。');
    if (isAdmin(identity)) return getProfile(email, identity);
    const supabase = getSupabase();
    const existing = await ensureProfileRow(email);
    const nickname = String(payload?.nickname || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
    const bio = String(payload?.bio || '').trim();
    if (!nickname || nickname.length > 40) throw new Error('昵称长度应为 1 至 40 个字符。');
    if (bio.length > 500) throw new Error('个人介绍不能超过 500 个字符。');

    let avatar = payload?.removeAvatar ? null : existing.avatar;
    let uploaded = null;
    if (payload?.avatar?.dataUrl) {
      const parsed = parseDataUrl(payload.avatar);
      if (!/^image\/(?:png|jpe?g|webp|gif)$/i.test(parsed.contentType)) throw new Error('头像仅支持 PNG、JPEG、WebP 或 GIF。');
      if (!parsed.buffer.length || parsed.buffer.length > PROFILE_AVATAR_MAX_BYTES) throw new Error('头像不能超过 5MB。');
      const storageUserId = await getStorageUserId(email);
      const sha256 = crypto.createHash('sha256').update(parsed.buffer).digest('hex');
      const ext = extensionFor(parsed.fileName, parsed.contentType);
      uploaded = await uploadObject({
        storagePath: `profiles/${storageUserId}/${sha256}${ext}`,
        buffer: parsed.buffer,
        contentType: parsed.contentType,
        fileName: parsed.fileName,
      });
      avatar = uploaded;
    }

    const {data, error} = await supabase
      .from('roadtrip_profiles')
      .update({nickname, bio, avatar})
      .eq('owner_email', email)
      .select('owner_email,nickname,bio,avatar,created_at,updated_at')
      .single();
    if (error) {
      if (uploaded) await removeDescriptors([uploaded]);
      throw error;
    }
    if (isDescriptor(existing.avatar) && existing.avatar.storagePath !== avatar?.storagePath) {
      await removeDescriptors([existing.avatar]);
    }
    return {
      ok: true,
      profile: await serializeProfile(email, data),
      contributions: await getContributions(email),
      editable: true,
    };
  };

  const uploadMessageAttachments = async (messageId, files) => {
    if (!Array.isArray(files) || !files.length) return [];
    if (files.length > MESSAGE_ATTACHMENT_LIMIT) throw new Error(`每条消息最多附加 ${MESSAGE_ATTACHMENT_LIMIT} 个文件。`);
    const descriptors = [];
    let total = 0;
    try {
      for (let index = 0; index < files.length; index += 1) {
        const parsed = parseDataUrl(files[index]);
        total += parsed.buffer.length;
        if (!parsed.buffer.length || parsed.buffer.length > MESSAGE_ATTACHMENT_MAX_BYTES) throw new Error('单个附件不能超过 20MB。');
        if (total > MESSAGE_ATTACHMENTS_MAX_BYTES) throw new Error('一条消息的附件总大小不能超过 50MB。');
        const sha256 = crypto.createHash('sha256').update(parsed.buffer).digest('hex');
        const ext = extensionFor(parsed.fileName, parsed.contentType);
        const descriptor = await uploadObject({
          storagePath: `forum/${messageId}/${sha256}-${index}${ext}`,
          buffer: parsed.buffer,
          contentType: parsed.contentType,
          fileName: parsed.fileName,
        });
        descriptors.push(descriptor);
      }
      return descriptors;
    } catch (error) {
      await removeDescriptors(descriptors);
      throw error;
    }
  };

  const resolveAttachments = async (attachments) =>
    Promise.all((attachments || []).filter(isDescriptor).map(async (item) => ({
      fileName: item.fileName || '附件',
      contentType: item.contentType || 'application/octet-stream',
      size: Number(item.size || 0),
      isImage: /^image\/(?:png|jpe?g|webp|gif)$/i.test(item.contentType || ''),
      url: await signedUrl(item),
    })));

  const listMessages = async ({limit = 100} = {}, identity) => {
    const supabase = getSupabase();
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100));
    const {data, error} = await supabase
      .from('roadtrip_forum_messages')
      .select('id,author_email,body,attachments,reply_to_id,withdrawn_at,created_at,updated_at')
      .order('created_at', {ascending: false})
      .limit(safeLimit);
    if (error) throw error;
    const messages = (data || []).reverse();
    const messageMap = new Map(messages.map((item) => [item.id, item]));
    const missingReplyIds = [...new Set(messages.map((item) => item.reply_to_id).filter((id) => id && !messageMap.has(id)))];
    if (missingReplyIds.length) {
      const {data: replies, error: replyError} = await supabase
        .from('roadtrip_forum_messages')
        .select('id,author_email,body,withdrawn_at,created_at')
        .in('id', missingReplyIds);
      if (replyError) throw replyError;
      (replies || []).forEach((item) => messageMap.set(item.id, item));
    }
    const emails = [...new Set([...messageMap.values()].map((item) => item.author_email).filter(Boolean))];
    let profileRows = [];
    if (emails.length) {
      const {data: profiles, error: profileError} = await supabase
        .from('roadtrip_profiles')
        .select('owner_email,nickname,bio,avatar,updated_at')
        .in('owner_email', emails);
      if (profileError) throw profileError;
      profileRows = profiles || [];
    }
    const profileRowMap = new Map(profileRows.map((item) => [item.owner_email, item]));
    const profiles = new Map();
    await Promise.all(emails.map(async (email) => {
      profiles.set(email, await serializeProfile(email, profileRowMap.get(email) || null));
    }));
    const serialized = await Promise.all(messages.map(async (item) => {
      const withdrawn = Boolean(item.withdrawn_at);
      const reply = item.reply_to_id ? messageMap.get(item.reply_to_id) : null;
      return {
        id: item.id,
        author: profiles.get(item.author_email) || await serializeProfile(item.author_email),
        body: withdrawn ? '' : item.body,
        attachments: withdrawn ? [] : await resolveAttachments(item.attachments),
        replyTo: reply ? {
          id: reply.id,
          author: profiles.get(reply.author_email) || await serializeProfile(reply.author_email),
          body: reply.withdrawn_at ? '' : String(reply.body || '').slice(0, 180),
          withdrawn: Boolean(reply.withdrawn_at),
        } : null,
        withdrawn,
        withdrawnAt: item.withdrawn_at,
        createdAt: item.created_at,
        mine: item.author_email === identity?.email,
      };
    }));
    return {ok: true, messages: serialized};
  };

  const postMessage = async (payload, identity) => {
    const email = normalizeEmail(identity?.email);
    if (!email) throw new Error('缺少用户邮箱。');
    const body = String(payload?.body || '').trim();
    if (body.length > 4000) throw new Error('消息不能超过 4000 个字符。');
    const files = Array.isArray(payload?.attachments) ? payload.attachments : [];
    if (!body && !files.length) throw new Error('请输入消息或选择附件。');
    const supabase = getSupabase();
    const replyToId = String(payload?.replyToId || '').trim() || null;
    if (replyToId) {
      const {data: reply, error: replyError} = await supabase
        .from('roadtrip_forum_messages')
        .select('id')
        .eq('id', replyToId)
        .maybeSingle();
      if (replyError) throw replyError;
      if (!reply) throw new Error('引用的消息不存在。');
    }
    const id = crypto.randomUUID();
    const attachments = await uploadMessageAttachments(id, files);
    const {error} = await supabase.from('roadtrip_forum_messages').insert({
      id,
      author_email: email,
      body,
      attachments,
      reply_to_id: replyToId,
    });
    if (error) {
      await removeDescriptors(attachments);
      throw error;
    }
    return {ok: true, id};
  };

  const withdrawMessage = async (messageId, identity) => {
    const email = normalizeEmail(identity?.email);
    const id = String(messageId || '').trim();
    const supabase = getSupabase();
    const {data: existing, error: readError} = await supabase
      .from('roadtrip_forum_messages')
      .select('id,author_email,attachments,withdrawn_at')
      .eq('id', id)
      .maybeSingle();
    if (readError) throw readError;
    if (!existing) {
      const error = new Error('消息不存在。');
      error.status = 404;
      throw error;
    }
    if (existing.author_email !== email) {
      const error = new Error('只能撤回自己的消息。');
      error.status = 403;
      throw error;
    }
    if (existing.withdrawn_at) return {ok: true};
    const {error} = await supabase
      .from('roadtrip_forum_messages')
      .update({body: '', attachments: [], withdrawn_at: new Date().toISOString()})
      .eq('id', id)
      .eq('author_email', email);
    if (error) throw error;
    await removeDescriptors(existing.attachments);
    return {ok: true};
  };

  return {
    getProfile,
    saveProfile,
    listMessages,
    postMessage,
    withdrawMessage,
  };
}

module.exports = {createCommunityService};
