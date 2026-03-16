const RAW_EXTENSIONS = ['.arw', '.cr2', '.nef', '.dng', '.raf', '.orf', '.rw2'];
const THUMB_WIDTH = 400;
const THUMB_QUALITY = 0.8;
const VIEW_QUALITY = 0.92;

function isRawFile(filename) {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  return RAW_EXTENSIONS.includes(ext);
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function generateId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  for (const b of bytes) id += chars[b % chars.length];
  return id;
}

/**
 * Convert an image file (or decoded RAW ImageData) to a JPEG blob using Canvas.
 */
function imageToJpeg(source, quality, maxWidth) {
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    const finish = (img, srcW, srcH) => {
      let w = srcW;
      let h = srcH;
      if (maxWidth && w > maxWidth) {
        h = Math.round((h * maxWidth) / w);
        w = maxWidth;
      }
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(
        (blob) => resolve({ blob, width: w, height: h }),
        'image/jpeg',
        quality
      );
    };

    if (source instanceof ImageData) {
      const bmp = createImageBitmap(source);
      bmp.then((img) => finish(img, source.width, source.height));
    } else if (source instanceof ImageBitmap) {
      finish(source, source.width, source.height);
    } else {
      // source is a File or Blob
      const img = new Image();
      img.onload = () => {
        finish(img, img.naturalWidth, img.naturalHeight);
        URL.revokeObjectURL(img.src);
      };
      img.src = URL.createObjectURL(source);
    }
  });
}

/**
 * Generate a thumbnail JPEG from a File or ImageData.
 */
async function makeThumbnail(source) {
  return imageToJpeg(source, THUMB_QUALITY, THUMB_WIDTH);
}

/**
 * Convert a standard image File to full-size JPEG (for non-JPEG inputs like PNG/HEIC).
 */
async function makeViewJpeg(source) {
  return imageToJpeg(source, VIEW_QUALITY, null);
}

/**
 * Decode a RAW file using LibRaw-Wasm in a Web Worker.
 * Returns ImageData containing the decoded pixels.
 */
let librawWorker = null;
let librawResolve = null;

function initLibrawWorker() {
  if (librawWorker) return;
  librawWorker = new Worker('/js/raw-worker.js', { type: 'module' });
  librawWorker.onmessage = (e) => {
    if (librawResolve) {
      librawResolve(e.data);
      librawResolve = null;
    }
  };
}

function decodeRawFile(arrayBuffer) {
  return new Promise((resolve, reject) => {
    initLibrawWorker();
    librawResolve = (data) => {
      if (data.error) reject(new Error(data.error));
      else resolve(data);
    };
    librawWorker.postMessage({ type: 'decode', buffer: arrayBuffer }, [arrayBuffer]);
  });
}

function uploadApp() {
  return {
    adminToken: '',
    authenticated: false,
    authError: '',

    spaceId: '',
    gallerySlug: '',
    eventSlug: '',

    spacesList: [],
    galleriesList: [],
    eventsList: [],

    showCreateSpace: false,
    showCreateGallery: false,
    showCreateEvent: false,

    showSpacePassword: false,
    editingPassword: false,
    editPasswordValue: '',
    passwordSaveResult: '',
    passwordSaveError: false,

    newSpaceName: '',
    newSpacePassword: '',
    createSpaceResult: '',

    newGalleryTitle: '',
    newGalleryDesc: '',
    createGalleryResult: '',

    newEventTitle: '',
    newEventDate: '',
    createEventResult: '',

    queue: [],
    isDragging: false,
    uploading: false,
    uploadedCount: 0,
    uploadStatus: '',

    get selectedSpaceName() {
      const s = this.spacesList.find(s => s.id === this.spaceId);
      return s ? s.name : '';
    },

    get selectedSpacePassword() {
      const s = this.spacesList.find(s => s.id === this.spaceId);
      return s ? s.password : '';
    },

    get selectedSpaceObj() {
      return this.spacesList.find(s => s.id === this.spaceId) || null;
    },

    get selectedGalleryObj() {
      return this.galleriesList.find(g => g.slug === this.gallerySlug) || null;
    },

    get selectedEventObj() {
      return this.eventsList.find(e => e.slug === this.eventSlug) || null;
    },

    get selectedGalleryTitle() {
      const g = this.galleriesList.find(g => g.slug === this.gallerySlug);
      return g ? g.title : '';
    },

    init() {
      const saved = localStorage.getItem('rg_admin_token');
      if (saved) {
        this.adminToken = saved;
        this.authenticated = true;
        this.loadSpaces();
      }
    },

    async checkAdmin() {
      if (!this.adminToken.trim()) {
        this.authError = 'Token required';
        return;
      }
      localStorage.setItem('rg_admin_token', this.adminToken);
      this.authenticated = true;
      this.authError = '';
      await this.loadSpaces();
    },

    async loadSpaces() {
      try {
        const res = await fetch('/api/admin/spaces', {
          headers: { 'Authorization': `Bearer ${this.adminToken}` },
        });
        const data = await res.json();
        this.spacesList = data.spaces || [];

        const savedSpace = localStorage.getItem('rg_spaceId');
        if (savedSpace && this.spacesList.some(s => s.id === savedSpace)) {
          this.spaceId = savedSpace;
          await this.loadGalleries();
        }
      } catch (e) {
        console.error('Failed to load spaces:', e);
      }
    },

    async onSpaceChange() {
      this.gallerySlug = '';
      this.eventSlug = '';
      this.galleriesList = [];
      this.eventsList = [];
      this.showSpacePassword = false;
      this.editingPassword = false;
      this.passwordSaveResult = '';
      localStorage.setItem('rg_spaceId', this.spaceId);
      if (this.spaceId) await this.loadGalleries();
    },

    async loadGalleries() {
      try {
        const res = await fetch(`/api/admin/spaces/${this.spaceId}/galleries`, {
          headers: { 'Authorization': `Bearer ${this.adminToken}` },
        });
        const data = await res.json();
        this.galleriesList = data.galleries || [];

        const savedGallery = localStorage.getItem('rg_gallerySlug');
        if (savedGallery && this.galleriesList.some(g => g.slug === savedGallery)) {
          this.gallerySlug = savedGallery;
          await this.loadEvents();
        }
      } catch (e) {
        console.error('Failed to load galleries:', e);
      }
    },

    async onGalleryChange() {
      this.eventSlug = '';
      this.eventsList = [];
      localStorage.setItem('rg_gallerySlug', this.gallerySlug);
      if (this.gallerySlug) await this.loadEvents();
    },

    async saveSpacePassword() {
      const pw = this.editPasswordValue.trim();
      if (!pw || pw === this.selectedSpacePassword) return;

      this.passwordSaveResult = '';
      this.passwordSaveError = false;

      try {
        const res = await fetch(`/api/admin/spaces/${this.spaceId}/password`, {
          method: 'PUT',
          headers: this.authHeaders(),
          body: JSON.stringify({ password: pw }),
        });
        const data = await res.json();
        if (data.ok) {
          const s = this.spacesList.find(s => s.id === this.spaceId);
          if (s) s.password = pw;
          this.editingPassword = false;
          this.passwordSaveResult = 'Password updated';
          setTimeout(() => this.passwordSaveResult = '', 3000);
        } else {
          this.passwordSaveError = true;
          this.passwordSaveResult = data.error || 'Failed to update';
        }
      } catch (e) {
        this.passwordSaveError = true;
        this.passwordSaveResult = 'Error: ' + e.message;
      }
    },

    async loadEvents() {
      try {
        const res = await fetch(`/api/admin/spaces/${this.spaceId}/galleries/${this.gallerySlug}/events`, {
          headers: { 'Authorization': `Bearer ${this.adminToken}` },
        });
        const data = await res.json();
        this.eventsList = data.events || [];

        const savedEvent = localStorage.getItem('rg_eventSlug');
        if (savedEvent && this.eventsList.some(e => e.slug === savedEvent)) {
          this.eventSlug = savedEvent;
        }
      } catch (e) {
        console.error('Failed to load events:', e);
      }
    },

    authHeaders() {
      return {
        'Authorization': `Bearer ${this.adminToken}`,
        'Content-Type': 'application/json',
      };
    },

    async createSpace() {
      this.createSpaceResult = '';
      if (!this.newSpaceName || !this.newSpacePassword) {
        this.createSpaceResult = 'Name and password are required';
        return;
      }
      try {
        const res = await fetch('/api/admin/spaces', {
          method: 'POST',
          headers: this.authHeaders(),
          body: JSON.stringify({ name: this.newSpaceName, password: this.newSpacePassword }),
        });
        const data = await res.json();
        if (data.ok) {
          this.createSpaceResult = `Space "${this.newSpaceName}" created!`;
          await this.loadSpaces();
          this.spaceId = data.spaceId;
          localStorage.setItem('rg_spaceId', this.spaceId);
          this.galleriesList = [];
          this.eventsList = [];
          this.gallerySlug = '';
          this.eventSlug = '';
          this.newSpaceName = '';
          this.newSpacePassword = '';
          this.showCreateSpace = false;
        } else {
          this.createSpaceResult = data.error || 'Failed';
        }
      } catch (e) {
        this.createSpaceResult = 'Error: ' + e.message;
      }
    },

    async createGallery() {
      this.createGalleryResult = '';
      if (!this.spaceId) { this.createGalleryResult = 'Select a space first'; return; }
      if (!this.newGalleryTitle) { this.createGalleryResult = 'Title is required'; return; }
      try {
        const res = await fetch('/api/admin/galleries', {
          method: 'POST',
          headers: this.authHeaders(),
          body: JSON.stringify({ spaceId: this.spaceId, title: this.newGalleryTitle, description: this.newGalleryDesc }),
        });
        const data = await res.json();
        if (data.ok) {
          this.createGalleryResult = `Gallery "${this.newGalleryTitle}" created!`;
          await this.loadGalleries();
          this.gallerySlug = data.slug;
          localStorage.setItem('rg_gallerySlug', this.gallerySlug);
          this.eventsList = [];
          this.eventSlug = '';
          this.newGalleryTitle = '';
          this.newGalleryDesc = '';
          this.showCreateGallery = false;
        } else {
          this.createGalleryResult = data.error || 'Failed';
        }
      } catch (e) {
        this.createGalleryResult = 'Error: ' + e.message;
      }
    },

    async createEvent() {
      this.createEventResult = '';
      if (!this.spaceId || !this.gallerySlug) {
        this.createEventResult = 'Select a space and gallery first';
        return;
      }
      if (!this.newEventTitle) { this.createEventResult = 'Title is required'; return; }
      try {
        const res = await fetch('/api/admin/events', {
          method: 'POST',
          headers: this.authHeaders(),
          body: JSON.stringify({
            spaceId: this.spaceId,
            gallerySlug: this.gallerySlug,
            title: this.newEventTitle,
            date: this.newEventDate,
          }),
        });
        const data = await res.json();
        if (data.ok) {
          this.createEventResult = `Event "${this.newEventTitle}" created!`;
          await this.loadEvents();
          this.eventSlug = data.slug;
          localStorage.setItem('rg_eventSlug', this.eventSlug);
          this.newEventTitle = '';
          this.newEventDate = '';
          this.showCreateEvent = false;
        } else {
          this.createEventResult = data.error || 'Failed';
        }
      } catch (e) {
        this.createEventResult = 'Error: ' + e.message;
      }
    },

    async confirmDeleteEvent() {
      const evt = this.eventsList.find(e => e.slug === this.eventSlug);
      const name = evt ? evt.title : this.eventSlug;
      if (!confirm(`Delete event "${name}" and all its photos?\n\nThis cannot be undone.`)) return;

      try {
        const res = await fetch('/api/admin/events', {
          method: 'DELETE',
          headers: this.authHeaders(),
          body: JSON.stringify({
            spaceId: this.spaceId,
            gallerySlug: this.gallerySlug,
            eventSlug: this.eventSlug,
          }),
        });
        const data = await res.json();
        if (data.ok) {
          this.eventSlug = '';
          localStorage.removeItem('rg_eventSlug');
          await this.loadEvents();
        } else {
          alert(data.error || 'Failed to delete event');
        }
      } catch (e) {
        alert('Error: ' + e.message);
      }
    },

    async confirmDeleteGallery() {
      const gal = this.galleriesList.find(g => g.slug === this.gallerySlug);
      const name = gal ? gal.title : this.gallerySlug;
      if (!confirm(`Delete gallery "${name}" and ALL its events and photos?\n\nThis cannot be undone.`)) return;

      try {
        const res = await fetch('/api/admin/galleries', {
          method: 'DELETE',
          headers: this.authHeaders(),
          body: JSON.stringify({
            spaceId: this.spaceId,
            gallerySlug: this.gallerySlug,
          }),
        });
        const data = await res.json();
        if (data.ok) {
          this.gallerySlug = '';
          this.eventSlug = '';
          this.eventsList = [];
          localStorage.removeItem('rg_gallerySlug');
          localStorage.removeItem('rg_eventSlug');
          await this.loadGalleries();
        } else {
          alert(data.error || 'Failed to delete gallery');
        }
      } catch (e) {
        alert('Error: ' + e.message);
      }
    },

    async confirmDeleteSpace() {
      const sp = this.spacesList.find(s => s.id === this.spaceId);
      const name = sp ? sp.name : this.spaceId;
      if (!confirm(`Delete space "${name}" and ALL its galleries, events, and photos?\n\nThis cannot be undone.`)) return;

      try {
        const res = await fetch('/api/admin/spaces', {
          method: 'DELETE',
          headers: this.authHeaders(),
          body: JSON.stringify({ spaceId: this.spaceId }),
        });
        const data = await res.json();
        if (data.ok) {
          this.spaceId = '';
          this.gallerySlug = '';
          this.eventSlug = '';
          this.galleriesList = [];
          this.eventsList = [];
          localStorage.removeItem('rg_spaceId');
          localStorage.removeItem('rg_gallerySlug');
          localStorage.removeItem('rg_eventSlug');
          await this.loadSpaces();
        } else {
          alert(data.error || 'Failed to delete space');
        }
      } catch (e) {
        alert('Error: ' + e.message);
      }
    },

    handleDrop(event) {
      this.isDragging = false;
      const files = event.dataTransfer?.files;
      if (files) this.addFiles(files);
    },

    handleFileSelect(event) {
      const files = event.target?.files;
      if (files) this.addFiles(files);
      event.target.value = '';
    },

    async addFiles(fileList) {
      const files = Array.from(fileList);
      for (const file of files) {
        const duplicate = this.queue.some(
          q => q.file.name === file.name && q.file.size === file.size
        );
        const raw = isRawFile(file.name);
        const item = {
          file,
          isRaw: raw,
          status: duplicate ? 'skip' : 'pending',
          thumbUrl: null,
          error: null,
        };

        if (!raw && file.type.startsWith('image/')) {
          try {
            const thumbResult = await makeThumbnail(file);
            item.thumbUrl = URL.createObjectURL(thumbResult.blob);
          } catch {}
        }

        this.queue.push(item);
      }
    },

    async startUpload() {
      if (this.uploading) return;
      if (!this.spaceId || !this.gallerySlug || !this.eventSlug) {
        alert('Please set Space ID, Gallery Slug, and Event Slug');
        return;
      }

      localStorage.setItem('rg_spaceId', this.spaceId);
      localStorage.setItem('rg_gallerySlug', this.gallerySlug);
      localStorage.setItem('rg_eventSlug', this.eventSlug);

      this.uploading = true;
      this.uploadedCount = 0;

      for (let i = 0; i < this.queue.length; i++) {
        const item = this.queue[i];
        if (item.status === 'done' || item.status === 'skip') { this.uploadedCount++; continue; }

        try {
          const photoId = generateId();

          let viewBlob, thumbBlob, viewWidth, viewHeight;
          let originalBuffer = null;

          if (item.isRaw) {
            // RAW file: decode via LibRaw-Wasm
            item.status = 'converting';
            this.uploadStatus = `Converting RAW: ${item.file.name}`;

            const rawBuffer = await item.file.arrayBuffer();
            // Keep a copy for uploading original
            originalBuffer = rawBuffer.slice(0);

            try {
              const decoded = await decodeRawFile(rawBuffer);
              const imageData = new ImageData(
                new Uint8ClampedArray(decoded.pixels),
                decoded.width,
                decoded.height
              );

              const viewResult = await makeViewJpeg(imageData);
              viewBlob = viewResult.blob;
              viewWidth = decoded.width;
              viewHeight = decoded.height;

              const thumbResult = await makeThumbnail(imageData);
              thumbBlob = thumbResult.blob;
            } catch (rawErr) {
              console.error('RAW decode failed, trying as regular image:', rawErr);
              // Fallback: try loading as a regular image (some RAW files have embedded previews)
              const viewResult = await makeViewJpeg(item.file);
              viewBlob = viewResult.blob;
              viewWidth = viewResult.width;
              viewHeight = viewResult.height;

              const thumbResult = await makeThumbnail(item.file);
              thumbBlob = thumbResult.blob;
              originalBuffer = null; // Don't upload as original if decode failed
            }
          } else {
            // Standard image file
            item.status = 'converting';
            this.uploadStatus = `Processing: ${item.file.name}`;

            if (item.file.type === 'image/jpeg') {
              viewBlob = item.file;
              const img = new Image();
              const dims = await new Promise((resolve) => {
                img.onload = () => { resolve({ w: img.naturalWidth, h: img.naturalHeight }); URL.revokeObjectURL(img.src); };
                img.src = URL.createObjectURL(item.file);
              });
              viewWidth = dims.w;
              viewHeight = dims.h;
            } else {
              const viewResult = await makeViewJpeg(item.file);
              viewBlob = viewResult.blob;
              viewWidth = viewResult.width;
              viewHeight = viewResult.height;
            }

            const thumbResult = await makeThumbnail(item.file);
            thumbBlob = thumbResult.blob;
          }

          // Upload view JPEG
          item.status = 'uploading';
          this.uploadStatus = `Uploading: ${item.file.name}`;

          const viewExt = 'view.jpg';
          await fetch(`/api/admin/upload/${photoId}/${viewExt}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${this.adminToken}`, 'Content-Type': 'image/jpeg' },
            body: viewBlob,
          });

          // Upload thumbnail
          const thumbExt = 'thumb.jpg';
          await fetch(`/api/admin/upload/${photoId}/${thumbExt}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${this.adminToken}`, 'Content-Type': 'image/jpeg' },
            body: thumbBlob,
          });

          // Upload original RAW if available
          let originalKey = null;
          if (originalBuffer) {
            const origName = 'original' + item.file.name.slice(item.file.name.lastIndexOf('.'));
            await fetch(`/api/admin/upload/${photoId}/${origName}`, {
              method: 'PUT',
              headers: { 'Authorization': `Bearer ${this.adminToken}`, 'Content-Type': 'application/octet-stream' },
              body: originalBuffer,
            });
            originalKey = `photos/${photoId}/${origName}`;
          }

          // Complete photo metadata
          await fetch('/api/admin/photos/complete', {
            method: 'POST',
            headers: this.authHeaders(),
            body: JSON.stringify({
              spaceId: this.spaceId,
              gallerySlug: this.gallerySlug,
              eventSlug: this.eventSlug,
              photo: {
                id: photoId,
                filename: item.file.name,
                originalKey,
                viewKey: `photos/${photoId}/${viewExt}`,
                thumbKey: `photos/${photoId}/${thumbExt}`,
                width: viewWidth,
                height: viewHeight,
                size: item.file.size,
                type: item.file.type || 'image/jpeg',
                created: new Date().toISOString(),
              },
            }),
          });

          item.status = 'done';
          this.uploadedCount++;
        } catch (e) {
          console.error('Upload error:', e);
          item.status = 'error';
          item.error = e.message;
          this.uploadedCount++;
        }
      }

      this.uploading = false;
      this.uploadStatus = 'Complete!';
    },

    formatSize,
  };
}
