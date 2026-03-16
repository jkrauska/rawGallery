/**
 * rawGallery Worker
 *
 * Password-gated photo gallery with hierarchical organization:
 *   Space (password) > Gallery > Event > Photos
 *
 * - Admin-only uploads with client-side RAW conversion
 * - On-the-fly image resizing via @cf-wasm/photon (WASM)
 * - R2 for storage, KV for metadata/sessions
 */

import {
  PhotonImage,
  SamplingFilter,
  resize,
} from "@cf-wasm/photon/workerd";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Env {
  MEDIA: R2Bucket;
  META: KVNamespace;
  ADMIN_TOKEN: string;
  HMAC_SECRET: string;
  SITE_NAME?: string;
}

interface SpaceConfig {
  id: string;
  name: string;
  password: string;
  created: string;
}

interface GalleryMeta {
  slug: string;
  title: string;
  description?: string;
  coverPhotoId?: string;
  created: string;
}

interface EventMeta {
  slug: string;
  title: string;
  date?: string;
  created: string;
}

interface PhotoMeta {
  id: string;
  filename: string;
  originalKey?: string; // R2 key for ARW/RAW original
  viewKey: string;      // R2 key for full-size JPEG
  thumbKey: string;     // R2 key for thumbnail JPEG
  width: number;
  height: number;
  size: number;
  type: string;
  caption?: string;
  exif?: Record<string, unknown>;
  created: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

function cors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  headers.set("access-control-allow-headers", "content-type, authorization");
  headers.set("access-control-allow-credentials", "true");
  headers.set("access-control-max-age", "86400");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  for (const b of bytes) id += chars[b % chars.length];
  return id;
}

function now(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// HMAC session cookies
// ---------------------------------------------------------------------------

const SESSION_COOKIE = "rg_session";
const SESSION_MAX_AGE = 60 * 60; // 1 hour

async function hmacSign(payload: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const hex = [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${payload}.${hex}`;
}

async function hmacVerify(
  token: string,
  secret: string
): Promise<string | null> {
  const dot = token.lastIndexOf(".");
  if (dot === -1) return null;
  const payload = token.slice(0, dot);
  const expected = await hmacSign(payload, secret);
  if (token !== expected) return null;
  // Check expiry
  try {
    const data = JSON.parse(payload);
    if (data.exp && Date.now() > data.exp) return null;
    return data.spaceId || null;
  } catch {
    return null;
  }
}

function getSessionToken(request: Request): string | null {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(
    new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`)
  );
  return match ? decodeURIComponent(match[1]) : null;
}

async function getSessionSpaceId(
  request: Request,
  env: Env
): Promise<string | null> {
  const token = getSessionToken(request);
  if (!token) return null;
  return hmacVerify(token, env.HMAC_SECRET);
}

function makeSessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_MAX_AGE}; SameSite=Lax; Secure; HttpOnly`;
}

function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; Secure; HttpOnly`;
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function isAdmin(request: Request, env: Env): boolean {
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  return auth.slice(7) === env.ADMIN_TOKEN;
}

async function hashPassword(password: string): Promise<string> {
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(password));
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

async function handleAuth(request: Request, env: Env): Promise<Response> {
  let body: { password?: string };
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON");
  }

  const { password } = body;
  if (!password || typeof password !== "string") {
    return err("Password is required");
  }

  const passwordHash = await hashPassword(password);
  const spaceRaw = await env.META.get(`space:${passwordHash}`);
  if (!spaceRaw) {
    return err("Invalid password", 401);
  }

  const space: SpaceConfig = JSON.parse(spaceRaw);
  const payload = JSON.stringify({
    spaceId: space.id,
    exp: Date.now() + SESSION_MAX_AGE * 1000,
  });
  const token = await hmacSign(payload, env.HMAC_SECRET);

  const response = json({ ok: true, spaceName: space.name, spaceId: space.id });
  const headers = new Headers(response.headers);
  headers.set("set-cookie", makeSessionCookie(token));
  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

function handleLogout(): Response {
  const response = json({ ok: true });
  const headers = new Headers(response.headers);
  headers.set("set-cookie", clearSessionCookie());
  return new Response(response.body, { status: 200, headers });
}

// ---------------------------------------------------------------------------
// Admin: space management
// ---------------------------------------------------------------------------

async function handleCreateSpace(
  request: Request,
  env: Env
): Promise<Response> {
  if (!isAdmin(request, env)) return err("Unauthorized", 401);

  let body: { name?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON");
  }

  const { name, password } = body;
  if (!name || !password) return err("name and password are required");

  const passwordHash = await hashPassword(password);
  const existing = await env.META.get(`space:${passwordHash}`);
  if (existing) return err("A space with this password already exists", 409);

  const spaceId = generateId();
  const space: SpaceConfig = { id: spaceId, name, password, created: now() };
  await env.META.put(`space:${passwordHash}`, JSON.stringify(space));
  await env.META.put(`spaceid:${spaceId}`, passwordHash);

  // Update spaces index
  const indexRaw = await env.META.get("index:spaces");
  const spaceIds: string[] = indexRaw ? JSON.parse(indexRaw) : [];
  if (!spaceIds.includes(spaceId)) {
    spaceIds.push(spaceId);
    await env.META.put("index:spaces", JSON.stringify(spaceIds));
  }

  return json({ ok: true, spaceId, name });
}

async function handleAdminListSpaces(
  request: Request,
  env: Env
): Promise<Response> {
  if (!isAdmin(request, env)) return err("Unauthorized", 401);

  const indexRaw = await env.META.get("index:spaces");
  if (!indexRaw) return json({ spaces: [] });

  const spaceIds: string[] = JSON.parse(indexRaw);
  const spaces: (SpaceConfig & { id: string; galleryCount: number })[] = [];

  for (const sid of spaceIds) {
    const hashKey = await env.META.get(`spaceid:${sid}`);
    if (!hashKey) continue;
    const spaceRaw = await env.META.get(`space:${hashKey}`);
    if (!spaceRaw) continue;
    const space = JSON.parse(spaceRaw);
    const galIdx = await env.META.get(`index:galleries:${sid}`);
    space.galleryCount = galIdx ? JSON.parse(galIdx).length : 0;
    spaces.push(space);
  }

  return json({ spaces });
}

async function handleAdminUpdateSpacePassword(
  request: Request,
  env: Env,
  spaceId: string
): Promise<Response> {
  if (!isAdmin(request, env)) return err("Unauthorized", 401);

  let body: { password?: string };
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON");
  }

  const newPassword = body.password;
  if (!newPassword) return err("password is required");

  const oldHash = await env.META.get(`spaceid:${spaceId}`);
  if (!oldHash) return err("Space not found", 404);

  const spaceRaw = await env.META.get(`space:${oldHash}`);
  if (!spaceRaw) return err("Space data missing", 404);

  const space: SpaceConfig = JSON.parse(spaceRaw);

  const newHash = await hashPassword(newPassword);
  if (newHash !== oldHash) {
    const conflict = await env.META.get(`space:${newHash}`);
    if (conflict) return err("Another space already uses this password", 409);

    await env.META.delete(`space:${oldHash}`);
  }

  space.password = newPassword;
  await env.META.put(`space:${newHash}`, JSON.stringify(space));
  await env.META.put(`spaceid:${spaceId}`, newHash);

  return json({ ok: true });
}

async function handleAdminListGalleries(
  request: Request,
  env: Env,
  spaceId: string
): Promise<Response> {
  if (!isAdmin(request, env)) return err("Unauthorized", 401);

  const indexRaw = await env.META.get(`index:galleries:${spaceId}`);
  if (!indexRaw) return json({ galleries: [] });

  const slugs: string[] = JSON.parse(indexRaw);
  const galleries: (GalleryMeta & { eventCount: number })[] = [];

  for (const slug of slugs) {
    const raw = await env.META.get(`gallery:${spaceId}:${slug}`);
    if (!raw) continue;
    const gal = JSON.parse(raw);
    const evtIdx = await env.META.get(`index:events:${spaceId}:${slug}`);
    gal.eventCount = evtIdx ? JSON.parse(evtIdx).length : 0;
    galleries.push(gal);
  }

  return json({ galleries });
}

async function handleAdminListEvents(
  request: Request,
  env: Env,
  spaceId: string,
  gallerySlug: string
): Promise<Response> {
  if (!isAdmin(request, env)) return err("Unauthorized", 401);

  const galRaw = await env.META.get(`gallery:${spaceId}:${gallerySlug}`);
  if (!galRaw) return err("Gallery not found", 404);

  const indexRaw = await env.META.get(
    `index:events:${spaceId}:${gallerySlug}`
  );
  if (!indexRaw)
    return json({ gallery: JSON.parse(galRaw), events: [] });

  const slugs: string[] = JSON.parse(indexRaw);
  const events: (EventMeta & { photoCount: number })[] = [];

  for (const slug of slugs) {
    const raw = await env.META.get(
      `event:${spaceId}:${gallerySlug}:${slug}`
    );
    if (!raw) continue;
    const evt = JSON.parse(raw);
    const photoIdx = await env.META.get(
      `index:photos:${spaceId}:${gallerySlug}:${slug}`
    );
    evt.photoCount = photoIdx ? JSON.parse(photoIdx).length : 0;
    events.push(evt);
  }

  return json({ gallery: JSON.parse(galRaw), events });
}

// ---------------------------------------------------------------------------
// Admin: gallery management
// ---------------------------------------------------------------------------

async function handleCreateGallery(
  request: Request,
  env: Env
): Promise<Response> {
  if (!isAdmin(request, env)) return err("Unauthorized", 401);

  let body: { spaceId?: string; title?: string; description?: string };
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON");
  }

  const { spaceId, title, description } = body;
  if (!spaceId || !title) return err("spaceId and title are required");

  const slug = slugify(title);
  const gallery: GalleryMeta = {
    slug,
    title,
    description,
    created: now(),
  };

  await env.META.put(
    `gallery:${spaceId}:${slug}`,
    JSON.stringify(gallery)
  );

  // Update index
  const indexKey = `index:galleries:${spaceId}`;
  const existingRaw = await env.META.get(indexKey);
  const existing: string[] = existingRaw ? JSON.parse(existingRaw) : [];
  if (!existing.includes(slug)) {
    existing.push(slug);
    await env.META.put(indexKey, JSON.stringify(existing));
  }

  return json({ ok: true, slug });
}

// ---------------------------------------------------------------------------
// Admin: event management
// ---------------------------------------------------------------------------

async function handleCreateEvent(
  request: Request,
  env: Env
): Promise<Response> {
  if (!isAdmin(request, env)) return err("Unauthorized", 401);

  let body: {
    spaceId?: string;
    gallerySlug?: string;
    title?: string;
    date?: string;
  };
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON");
  }

  const { spaceId, gallerySlug, title, date } = body;
  if (!spaceId || !gallerySlug || !title)
    return err("spaceId, gallerySlug, and title are required");

  const datePrefix = date ? date.replace(/-/g, "") + "-" : "";
  const slug = datePrefix + slugify(title);
  const event: EventMeta = { slug, title, date, created: now() };

  await env.META.put(
    `event:${spaceId}:${gallerySlug}:${slug}`,
    JSON.stringify(event)
  );

  const indexKey = `index:events:${spaceId}:${gallerySlug}`;
  const existingRaw = await env.META.get(indexKey);
  const existing: string[] = existingRaw ? JSON.parse(existingRaw) : [];
  if (!existing.includes(slug)) {
    existing.push(slug);
    await env.META.put(indexKey, JSON.stringify(existing));
  }

  return json({ ok: true, slug });
}

// ---------------------------------------------------------------------------
// Admin: photo upload
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 150 * 1024 * 1024; // 150MB (ARW files can be large)

async function handleUploadPhoto(
  request: Request,
  env: Env,
  variant: string,
  photoId: string
): Promise<Response> {
  if (!isAdmin(request, env)) return err("Unauthorized", 401);

  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    if (size > MAX_FILE_SIZE) return err("File too large", 413);
  }
  if (!request.body) return err("Missing body", 400);

  const contentType =
    request.headers.get("content-type") || "application/octet-stream";

  const key = `photos/${photoId}/${variant}`;
  await env.MEDIA.put(key, request.body, {
    httpMetadata: { contentType },
  });

  return json({ ok: true, key });
}

async function handleCompletePhoto(
  request: Request,
  env: Env
): Promise<Response> {
  if (!isAdmin(request, env)) return err("Unauthorized", 401);

  let body: {
    spaceId?: string;
    gallerySlug?: string;
    eventSlug?: string;
    photo?: PhotoMeta;
  };
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON");
  }

  const { spaceId, gallerySlug, eventSlug, photo } = body;
  if (!spaceId || !gallerySlug || !eventSlug || !photo)
    return err("Missing required fields");

  await env.META.put(
    `photo:${spaceId}:${gallerySlug}:${eventSlug}:${photo.id}`,
    JSON.stringify(photo)
  );

  const indexKey = `index:photos:${spaceId}:${gallerySlug}:${eventSlug}`;
  const existingRaw = await env.META.get(indexKey);
  const existing: string[] = existingRaw ? JSON.parse(existingRaw) : [];
  if (!existing.includes(photo.id)) {
    existing.push(photo.id);
    await env.META.put(indexKey, JSON.stringify(existing));
  }

  return json({ ok: true, photoId: photo.id });
}

// ---------------------------------------------------------------------------
// Admin: delete photo
// ---------------------------------------------------------------------------

async function handleDeletePhoto(
  request: Request,
  env: Env
): Promise<Response> {
  if (!isAdmin(request, env)) return err("Unauthorized", 401);

  let body: {
    spaceId?: string;
    gallerySlug?: string;
    eventSlug?: string;
    photoId?: string;
  };
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON");
  }

  const { spaceId, gallerySlug, eventSlug, photoId } = body;
  if (!spaceId || !gallerySlug || !eventSlug || !photoId)
    return err("Missing required fields");

  const metaKey = `photo:${spaceId}:${gallerySlug}:${eventSlug}:${photoId}`;
  const photoRaw = await env.META.get(metaKey);
  if (photoRaw) {
    const photo: PhotoMeta = JSON.parse(photoRaw);
    // Delete all R2 variants
    const keysToDelete = [photo.viewKey, photo.thumbKey];
    if (photo.originalKey) keysToDelete.push(photo.originalKey);
    await Promise.all(keysToDelete.map((k) => env.MEDIA.delete(k)));
  }

  await env.META.delete(metaKey);

  // Remove from index
  const indexKey = `index:photos:${spaceId}:${gallerySlug}:${eventSlug}`;
  const indexRaw = await env.META.get(indexKey);
  if (indexRaw) {
    const ids: string[] = JSON.parse(indexRaw);
    const filtered = ids.filter((id) => id !== photoId);
    if (filtered.length > 0) {
      await env.META.put(indexKey, JSON.stringify(filtered));
    } else {
      await env.META.delete(indexKey);
    }
  }

  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Admin: delete event (cascades to photos)
// ---------------------------------------------------------------------------

async function deleteAllPhotosInEvent(
  env: Env,
  spaceId: string,
  gallerySlug: string,
  eventSlug: string
): Promise<number> {
  const indexKey = `index:photos:${spaceId}:${gallerySlug}:${eventSlug}`;
  const indexRaw = await env.META.get(indexKey);
  if (!indexRaw) return 0;

  const photoIds: string[] = JSON.parse(indexRaw);
  for (const pid of photoIds) {
    const metaKey = `photo:${spaceId}:${gallerySlug}:${eventSlug}:${pid}`;
    const photoRaw = await env.META.get(metaKey);
    if (photoRaw) {
      const photo: PhotoMeta = JSON.parse(photoRaw);
      const keysToDelete = [photo.viewKey, photo.thumbKey];
      if (photo.originalKey) keysToDelete.push(photo.originalKey);
      await Promise.all(keysToDelete.map((k) => env.MEDIA.delete(k)));
    }
    await env.META.delete(metaKey);
  }
  await env.META.delete(indexKey);
  return photoIds.length;
}

async function handleDeleteEvent(
  request: Request,
  env: Env
): Promise<Response> {
  if (!isAdmin(request, env)) return err("Unauthorized", 401);

  let body: { spaceId?: string; gallerySlug?: string; eventSlug?: string };
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON");
  }

  const { spaceId, gallerySlug, eventSlug } = body;
  if (!spaceId || !gallerySlug || !eventSlug)
    return err("spaceId, gallerySlug, and eventSlug are required");

  const photosDeleted = await deleteAllPhotosInEvent(
    env,
    spaceId,
    gallerySlug,
    eventSlug
  );

  await env.META.delete(`event:${spaceId}:${gallerySlug}:${eventSlug}`);

  const idxKey = `index:events:${spaceId}:${gallerySlug}`;
  const idxRaw = await env.META.get(idxKey);
  if (idxRaw) {
    const slugs: string[] = JSON.parse(idxRaw);
    const filtered = slugs.filter((s) => s !== eventSlug);
    if (filtered.length > 0) {
      await env.META.put(idxKey, JSON.stringify(filtered));
    } else {
      await env.META.delete(idxKey);
    }
  }

  return json({ ok: true, photosDeleted });
}

// ---------------------------------------------------------------------------
// Admin: delete gallery (cascades to events → photos)
// ---------------------------------------------------------------------------

async function handleDeleteGallery(
  request: Request,
  env: Env
): Promise<Response> {
  if (!isAdmin(request, env)) return err("Unauthorized", 401);

  let body: { spaceId?: string; gallerySlug?: string };
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON");
  }

  const { spaceId, gallerySlug } = body;
  if (!spaceId || !gallerySlug)
    return err("spaceId and gallerySlug are required");

  // Delete all events in this gallery
  const evtIdxKey = `index:events:${spaceId}:${gallerySlug}`;
  const evtIdxRaw = await env.META.get(evtIdxKey);
  let eventsDeleted = 0;
  let photosDeleted = 0;
  if (evtIdxRaw) {
    const eventSlugs: string[] = JSON.parse(evtIdxRaw);
    for (const es of eventSlugs) {
      photosDeleted += await deleteAllPhotosInEvent(
        env,
        spaceId,
        gallerySlug,
        es
      );
      await env.META.delete(`event:${spaceId}:${gallerySlug}:${es}`);
      eventsDeleted++;
    }
    await env.META.delete(evtIdxKey);
  }

  await env.META.delete(`gallery:${spaceId}:${gallerySlug}`);

  const idxKey = `index:galleries:${spaceId}`;
  const idxRaw = await env.META.get(idxKey);
  if (idxRaw) {
    const slugs: string[] = JSON.parse(idxRaw);
    const filtered = slugs.filter((s) => s !== gallerySlug);
    if (filtered.length > 0) {
      await env.META.put(idxKey, JSON.stringify(filtered));
    } else {
      await env.META.delete(idxKey);
    }
  }

  return json({ ok: true, eventsDeleted, photosDeleted });
}

// ---------------------------------------------------------------------------
// Admin: delete space (cascades to galleries → events → photos)
// ---------------------------------------------------------------------------

async function handleDeleteSpace(
  request: Request,
  env: Env
): Promise<Response> {
  if (!isAdmin(request, env)) return err("Unauthorized", 401);

  let body: { spaceId?: string };
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON");
  }

  const { spaceId } = body;
  if (!spaceId) return err("spaceId is required");

  // Delete all galleries (which cascades to events and photos)
  const galIdxKey = `index:galleries:${spaceId}`;
  const galIdxRaw = await env.META.get(galIdxKey);
  let galleriesDeleted = 0;
  let eventsDeleted = 0;
  let photosDeleted = 0;

  if (galIdxRaw) {
    const gallerySlugs: string[] = JSON.parse(galIdxRaw);
    for (const gs of gallerySlugs) {
      const evtIdxKey = `index:events:${spaceId}:${gs}`;
      const evtIdxRaw = await env.META.get(evtIdxKey);
      if (evtIdxRaw) {
        const eventSlugs: string[] = JSON.parse(evtIdxRaw);
        for (const es of eventSlugs) {
          photosDeleted += await deleteAllPhotosInEvent(
            env,
            spaceId,
            gs,
            es
          );
          await env.META.delete(`event:${spaceId}:${gs}:${es}`);
          eventsDeleted++;
        }
        await env.META.delete(evtIdxKey);
      }
      await env.META.delete(`gallery:${spaceId}:${gs}`);
      galleriesDeleted++;
    }
    await env.META.delete(galIdxKey);
  }

  // Delete the space itself
  const hashKey = await env.META.get(`spaceid:${spaceId}`);
  if (hashKey) {
    await env.META.delete(`space:${hashKey}`);
    await env.META.delete(`spaceid:${spaceId}`);
  }

  // Remove from index
  const spIdxRaw = await env.META.get("index:spaces");
  if (spIdxRaw) {
    const ids: string[] = JSON.parse(spIdxRaw);
    const filtered = ids.filter((id) => id !== spaceId);
    if (filtered.length > 0) {
      await env.META.put("index:spaces", JSON.stringify(filtered));
    } else {
      await env.META.delete("index:spaces");
    }
  }

  return json({ ok: true, galleriesDeleted, eventsDeleted, photosDeleted });
}

// ---------------------------------------------------------------------------
// Viewer: list galleries / events / photos
// ---------------------------------------------------------------------------

function pickRandom<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  const result: T[] = [];
  for (let i = 0; i < n && copy.length > 0; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    result.push(copy.splice(idx, 1)[0]);
  }
  return result;
}

async function handleListGalleries(
  spaceId: string,
  env: Env
): Promise<Response> {
  const indexRaw = await env.META.get(`index:galleries:${spaceId}`);
  if (!indexRaw) return json({ galleries: [] });

  const slugs: string[] = JSON.parse(indexRaw);
  const galleries: (GalleryMeta & {
    previews: { eventSlug: string; photoId: string }[];
    eventCount: number;
  })[] = [];

  for (const slug of slugs) {
    const raw = await env.META.get(`gallery:${spaceId}:${slug}`);
    if (!raw) continue;
    const gal = JSON.parse(raw);

    const allPhotos: { eventSlug: string; photoId: string }[] = [];
    const evtIdxRaw = await env.META.get(
      `index:events:${spaceId}:${slug}`
    );
    if (evtIdxRaw) {
      const eventSlugs: string[] = JSON.parse(evtIdxRaw);
      for (const es of eventSlugs) {
        const photoIdxRaw = await env.META.get(
          `index:photos:${spaceId}:${slug}:${es}`
        );
        if (photoIdxRaw) {
          const pids: string[] = JSON.parse(photoIdxRaw);
          for (const pid of pids) {
            allPhotos.push({ eventSlug: es, photoId: pid });
          }
        }
      }
    }
    gal.previews = pickRandom(allPhotos, 3);
    gal.eventCount = evtIdxRaw ? JSON.parse(evtIdxRaw).length : 0;
    galleries.push(gal);
  }

  return json({ galleries });
}

async function handleListEvents(
  spaceId: string,
  gallerySlug: string,
  env: Env
): Promise<Response> {
  const galRaw = await env.META.get(`gallery:${spaceId}:${gallerySlug}`);
  if (!galRaw) return err("Gallery not found", 404);

  const indexRaw = await env.META.get(
    `index:events:${spaceId}:${gallerySlug}`
  );
  if (!indexRaw) return json({ gallery: JSON.parse(galRaw), events: [] });

  const slugs: string[] = JSON.parse(indexRaw);
  const events: (EventMeta & {
    previews: string[];
    photoCount: number;
  })[] = [];

  for (const slug of slugs) {
    const raw = await env.META.get(
      `event:${spaceId}:${gallerySlug}:${slug}`
    );
    if (!raw) continue;
    const evt = JSON.parse(raw);
    const photoIdxRaw = await env.META.get(
      `index:photos:${spaceId}:${gallerySlug}:${slug}`
    );
    const pids: string[] = photoIdxRaw ? JSON.parse(photoIdxRaw) : [];
    evt.previews = pickRandom(pids, 3);
    evt.photoCount = pids.length;
    events.push(evt);
  }

  return json({ gallery: JSON.parse(galRaw), events });
}

async function handleListPhotos(
  spaceId: string,
  gallerySlug: string,
  eventSlug: string,
  env: Env
): Promise<Response> {
  const eventRaw = await env.META.get(
    `event:${spaceId}:${gallerySlug}:${eventSlug}`
  );
  if (!eventRaw) return err("Event not found", 404);

  const indexRaw = await env.META.get(
    `index:photos:${spaceId}:${gallerySlug}:${eventSlug}`
  );
  if (!indexRaw)
    return json({ event: JSON.parse(eventRaw), photos: [] });

  const ids: string[] = JSON.parse(indexRaw);
  const results = await Promise.all(
    ids.map((id) =>
      env.META.get(`photo:${spaceId}:${gallerySlug}:${eventSlug}:${id}`)
    )
  );
  const photos: PhotoMeta[] = results
    .filter((r): r is string => r !== null)
    .map((r) => JSON.parse(r));

  return json({ event: JSON.parse(eventRaw), photos });
}

// ---------------------------------------------------------------------------
// Image serving with on-the-fly resize
// ---------------------------------------------------------------------------

async function handleServePhoto(
  request: Request,
  env: Env,
  r2Key: string,
  width?: number
): Promise<Response> {
  const cacheKey = width
    ? `${request.url}` // URL already includes ?w=
    : request.url;
  const cache = caches.default;

  // Check cache first
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const object = await env.MEDIA.get(r2Key);
  if (!object) return err("Not found", 404);

  let body: ArrayBuffer | ReadableStream = object.body;
  let contentType = object.httpMetadata?.contentType || "image/jpeg";

  if (width && width > 0 && width < 6000) {
    const inputBytes = new Uint8Array(await object.arrayBuffer());
    let inputImage: PhotonImage | undefined;
    let outputImage: PhotonImage | undefined;

    try {
      inputImage = PhotonImage.new_from_byteslice(inputBytes);
      const origWidth = inputImage.get_width();
      const origHeight = inputImage.get_height();

      if (width < origWidth) {
        const newHeight = Math.round((origHeight * width) / origWidth);
        outputImage = resize(
          inputImage,
          width,
          newHeight,
          SamplingFilter.Lanczos3
        );
        inputImage.free();
        inputImage = undefined;

        const outputBytes = outputImage.get_bytes_jpeg(85);
        outputImage.free();
        outputImage = undefined;

        contentType = "image/jpeg";
        body = outputBytes.buffer as ArrayBuffer;
      } else {
        inputImage.free();
        inputImage = undefined;
        body = inputBytes.buffer as ArrayBuffer;
      }
    } catch (e) {
      console.error("Resize error:", e);
      if (inputImage) inputImage.free();
      if (outputImage) outputImage.free();
      body = inputBytes.buffer as ArrayBuffer;
    }
  }

  const headers = new Headers();
  headers.set("content-type", contentType);
  headers.set("cache-control", "public, max-age=31536000, immutable");

  const response = new Response(body, { headers });

  // Store in CF cache (non-blocking)
  const cacheResponse = new Response(response.clone().body, {
    headers: response.headers,
  });
  await cache.put(cacheKey, cacheResponse);

  return response;
}

async function handleServeOriginal(
  env: Env,
  r2Key: string
): Promise<Response> {
  const object = await env.MEDIA.get(r2Key);
  if (!object) return err("Not found", 404);

  const headers = new Headers();
  headers.set(
    "content-type",
    object.httpMetadata?.contentType || "application/octet-stream"
  );
  headers.set("content-length", String(object.size));
  const filename = r2Key.split("/").pop() || "original";
  headers.set(
    "content-disposition",
    `attachment; filename="${filename}"`
  );

  return new Response(object.body, { headers });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const origin = request.headers.get("origin") || "*";

    if (method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }), origin);
    }

    let response: Response;

    try {
      // --- Auth routes ---
      if (method === "POST" && path === "/api/auth") {
        response = await handleAuth(request, env);
      } else if (method === "POST" && path === "/api/logout") {
        response = handleLogout();
      } else if (method === "GET" && path === "/api/session") {
        const spaceId = await getSessionSpaceId(request, env);
        if (!spaceId) {
          response = json({ authenticated: false });
        } else {
          const hashKey = await env.META.get(`spaceid:${spaceId}`);
          let spaceName = "";
          if (hashKey) {
            const spaceRaw = await env.META.get(`space:${hashKey}`);
            if (spaceRaw) spaceName = JSON.parse(spaceRaw).name;
          }
          response = json({
            authenticated: true,
            spaceId,
            spaceName,
            siteName: env.SITE_NAME || "Gallery",
          });
        }

      // --- Admin routes ---
      } else if (method === "GET" && path === "/api/admin/spaces") {
        response = await handleAdminListSpaces(request, env);
      } else if (method === "POST" && path === "/api/admin/spaces") {
        response = await handleCreateSpace(request, env);
      } else if (
        method === "PUT" &&
        path.match(/^\/api\/admin\/spaces\/[^/]+\/password$/)
      ) {
        const spaceId = path.split("/")[4];
        response = await handleAdminUpdateSpacePassword(request, env, spaceId);
      } else if (
        method === "GET" &&
        path.match(/^\/api\/admin\/spaces\/[^/]+\/galleries$/)
      ) {
        const spaceId = path.split("/")[4];
        response = await handleAdminListGalleries(request, env, spaceId);
      } else if (method === "POST" && path === "/api/admin/galleries") {
        response = await handleCreateGallery(request, env);
      } else if (
        method === "GET" &&
        path.match(/^\/api\/admin\/spaces\/[^/]+\/galleries\/[^/]+\/events$/)
      ) {
        const parts = path.split("/");
        const spaceId = parts[4];
        const gallerySlug = parts[6];
        response = await handleAdminListEvents(request, env, spaceId, gallerySlug);
      } else if (method === "POST" && path === "/api/admin/events") {
        response = await handleCreateEvent(request, env);
      } else if (
        method === "PUT" &&
        path.startsWith("/api/admin/upload/")
      ) {
        // /api/admin/upload/:photoId/:variant (e.g., view.jpg, thumb.jpg, original.ARW)
        const parts = path.slice("/api/admin/upload/".length).split("/");
        if (parts.length < 2) {
          response = err("Invalid upload path", 400);
        } else {
          const photoId = parts[0];
          const variant = parts.slice(1).join("/");
          response = await handleUploadPhoto(request, env, variant, photoId);
        }
      } else if (method === "POST" && path === "/api/admin/photos/complete") {
        response = await handleCompletePhoto(request, env);
      } else if (method === "DELETE" && path === "/api/admin/photos") {
        response = await handleDeletePhoto(request, env);
      } else if (method === "DELETE" && path === "/api/admin/events") {
        response = await handleDeleteEvent(request, env);
      } else if (method === "DELETE" && path === "/api/admin/galleries") {
        response = await handleDeleteGallery(request, env);
      } else if (method === "DELETE" && path === "/api/admin/spaces") {
        response = await handleDeleteSpace(request, env);

      // --- Viewer routes (require session) ---
      } else if (method === "GET" && path === "/api/galleries") {
        const spaceId = await getSessionSpaceId(request, env);
        if (!spaceId) return cors(err("Unauthorized", 401), origin);
        response = await handleListGalleries(spaceId, env);
      } else if (
        method === "GET" &&
        path.match(/^\/api\/galleries\/[^/]+\/events$/)
      ) {
        const spaceId = await getSessionSpaceId(request, env);
        if (!spaceId) return cors(err("Unauthorized", 401), origin);
        const gallerySlug = path.split("/")[3];
        response = await handleListEvents(spaceId, gallerySlug, env);
      } else if (
        method === "GET" &&
        path.match(/^\/api\/galleries\/[^/]+\/events\/[^/]+\/photos$/)
      ) {
        const spaceId = await getSessionSpaceId(request, env);
        if (!spaceId) return cors(err("Unauthorized", 401), origin);
        const parts = path.split("/");
        const gallerySlug = parts[3];
        const eventSlug = parts[5];
        response = await handleListPhotos(
          spaceId,
          gallerySlug,
          eventSlug,
          env
        );

      // --- Photo serving ---
      } else if (
        method === "GET" &&
        path.startsWith("/api/photo/")
      ) {
        const spaceId = await getSessionSpaceId(request, env);
        if (!spaceId) return cors(err("Unauthorized", 401), origin);

        const rest = path.slice("/api/photo/".length);
        const isOriginal = rest.endsWith("/original");
        const isThumb = rest.endsWith("/thumb");

        let photoMetaKey: string;
        if (isOriginal || isThumb) {
          photoMetaKey = rest.slice(0, rest.lastIndexOf("/"));
        } else {
          photoMetaKey = rest;
        }

        // photoMetaKey = gallerySlug/eventSlug/photoId
        const keyParts = photoMetaKey.split("/");
        if (keyParts.length !== 3) {
          response = err("Invalid photo path", 400);
        } else {
          const [gallerySlug, eventSlug, photoId] = keyParts;
          const metaRaw = await env.META.get(
            `photo:${spaceId}:${gallerySlug}:${eventSlug}:${photoId}`
          );
          if (!metaRaw) {
            response = err("Photo not found", 404);
          } else {
            const photo: PhotoMeta = JSON.parse(metaRaw);
            if (isOriginal && photo.originalKey) {
              response = await handleServeOriginal(env, photo.originalKey);
            } else if (isThumb) {
              response = await handleServePhoto(
                request,
                env,
                photo.thumbKey
              );
            } else {
              const w = url.searchParams.get("w");
              const width = w ? parseInt(w, 10) : undefined;
              response = await handleServePhoto(
                request,
                env,
                photo.viewKey,
                width
              );
            }
          }
        }

      // --- Config ---
      } else if (method === "GET" && path === "/api/config") {
        response = json({
          siteName: env.SITE_NAME || "Gallery",
        });

      } else {
        response = err("Not found", 404);
      }
    } catch (e) {
      console.error("Worker error:", e);
      response = err("Internal server error", 500);
    }

    return cors(response, origin);
  },
};
