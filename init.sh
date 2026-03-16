#!/usr/bin/env bash
set -euo pipefail

WORKER_DIR="$(cd "$(dirname "$0")/worker" && pwd)"
TOML_TEMPLATE="$WORKER_DIR/wrangler.toml.default"
TOML_OUT="$WORKER_DIR/wrangler.toml"
DEV_VARS="$WORKER_DIR/.dev.vars"

bold() { printf "\033[1m%s\033[0m" "$1"; }
green() { printf "\033[32m%s\033[0m" "$1"; }
yellow() { printf "\033[33m%s\033[0m" "$1"; }

prompt() {
  local varname="$1" prompt_text="$2" default="$3"
  if [ -n "$default" ]; then
    printf "%s [$(yellow "$default")]: " "$prompt_text"
  else
    printf "%s: " "$prompt_text"
  fi
  read -r value
  value="${value:-$default}"
  eval "$varname=\"\$value\""
}

echo ""
echo "$(bold '=== rawGallery Init ===')"
echo ""
echo "This will create Cloudflare resources and configure your project."
echo "Make sure you are logged into wrangler: $(yellow 'npx wrangler whoami')"
echo ""

# ---- Check wrangler auth ----
if ! (cd "$WORKER_DIR" && npx wrangler whoami 2>/dev/null | grep -q "Account ID"); then
  echo "$(yellow 'Warning'): Could not verify wrangler login."
  printf "Continue anyway? [y/N]: "
  read -r cont
  if [[ "$cont" != [yY]* ]]; then echo "Aborted."; exit 1; fi
fi

# ---- Gather values ----
echo ""
echo "$(bold '1. Worker name')"
prompt WORKER_NAME "  Worker name" "raw-gallery"

echo ""
echo "$(bold '2. R2 bucket')"
prompt BUCKET_NAME "  R2 bucket name" "raw-gallery-media"

echo ""
echo "$(bold '3. KV namespace')"
prompt KV_DISPLAY_NAME "  KV namespace display name" "GALLERY_META"

echo ""
echo "$(bold '4. Site name (shown in the UI)')"
prompt SITE_NAME "  Site name" "Photo Gallery"

echo ""
echo "$(bold '5. Custom domain (optional)')"
prompt CUSTOM_DOMAIN "  Domain (leave blank to skip)" ""

echo ""
echo "$(bold '6. Secrets')"
prompt ADMIN_TOKEN "  Admin token (for uploads)" "$(openssl rand -hex 16 2>/dev/null || head -c 32 /dev/urandom | xxd -p | head -c 32)"
HMAC_SECRET="$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | xxd -p | head -c 64)"
echo "  HMAC secret: $(yellow '(auto-generated)')"

# ---- Create R2 bucket ----
echo ""
echo "$(bold 'Creating R2 bucket...')"
if (cd "$WORKER_DIR" && npx wrangler r2 bucket create "$BUCKET_NAME" 2>&1); then
  echo "$(green '✓') R2 bucket $(yellow "$BUCKET_NAME") ready"
else
  echo "$(yellow '⚠') Bucket may already exist — continuing"
fi

# ---- Create KV namespace ----
echo ""
echo "$(bold 'Creating KV namespace...')"
KV_OUTPUT=$(cd "$WORKER_DIR" && npx wrangler kv namespace create "$KV_DISPLAY_NAME" 2>&1) || true
echo "$KV_OUTPUT"

KV_ID=$(echo "$KV_OUTPUT" | grep -oE '[0-9a-f]{32}' | head -1)
if [ -z "$KV_ID" ]; then
  echo "$(yellow '⚠') Could not extract KV namespace ID automatically."
  prompt KV_ID "  Enter KV namespace ID manually" ""
fi
echo "$(green '✓') KV namespace ID: $(yellow "$KV_ID")"

# ---- Write wrangler.toml ----
echo ""
echo "$(bold 'Writing wrangler.toml...')"

cat > "$TOML_OUT" <<TOML
name = "${WORKER_NAME}"
main = "src/index.ts"
compatibility_date = "2024-12-01"

[assets]
directory = "../site"
binding = "ASSETS"
run_worker_first = ["/api/*"]

[vars]
SITE_NAME = "${SITE_NAME}"

[[r2_buckets]]
binding = "MEDIA"
bucket_name = "${BUCKET_NAME}"

[[kv_namespaces]]
binding = "META"
id = "${KV_ID}"
TOML

echo "$(green '✓') Written to $(yellow "$TOML_OUT")"

if [ -n "$CUSTOM_DOMAIN" ]; then
  # Insert routes block after account_id / compatibility_date, before [assets]
  # We use a temp file to splice it in at the right place
  ROUTES_BLOCK=$(cat <<ROUTES

# Custom domain
routes = [
  { pattern = "${CUSTOM_DOMAIN}/*", zone_name = "${CUSTOM_DOMAIN}" }
]
ROUTES
)
  # Insert after the compatibility_date line
  TMPFILE=$(mktemp)
  awk -v block="$ROUTES_BLOCK" '/^compatibility_date/ { print; print block; next } 1' "$TOML_OUT" > "$TMPFILE"
  mv "$TMPFILE" "$TOML_OUT"
  echo "  Custom domain route: $(yellow "${CUSTOM_DOMAIN}/*")"
fi

# ---- Write .dev.vars ----
echo ""
echo "$(bold 'Writing .dev.vars for local dev...')"

cat > "$DEV_VARS" <<VARS
ADMIN_TOKEN=${ADMIN_TOKEN}
HMAC_SECRET=${HMAC_SECRET}
VARS

echo "$(green '✓') Written to $(yellow "$DEV_VARS")"

# ---- Set production secrets ----
echo ""
echo "$(bold 'Setting production secrets...')"
(cd "$WORKER_DIR" && echo "$ADMIN_TOKEN" | npx wrangler secret put ADMIN_TOKEN 2>&1) || echo "$(yellow '⚠') Failed to set ADMIN_TOKEN — set it manually later"
(cd "$WORKER_DIR" && echo "$HMAC_SECRET" | npx wrangler secret put HMAC_SECRET 2>&1) || echo "$(yellow '⚠') Failed to set HMAC_SECRET — set it manually later"

# ---- Summary ----
echo ""
echo "$(bold '=== Setup Complete ===')"
echo ""
echo "  Worker:      $(yellow "$WORKER_NAME")"
echo "  R2 bucket:   $(yellow "$BUCKET_NAME")"
echo "  KV namespace:$(yellow "$KV_ID")"
echo "  Site name:   $(yellow "$SITE_NAME")"
echo "  Admin token: $(yellow "$ADMIN_TOKEN")"
if [ -n "$CUSTOM_DOMAIN" ]; then
echo "  Domain:      $(yellow "$CUSTOM_DOMAIN")"
fi
echo ""
echo "  Config:      $(yellow "$TOML_OUT")"
echo "  Dev vars:    $(yellow "$DEV_VARS")"
echo "  Template:    $(yellow "$TOML_TEMPLATE")"
echo ""
echo "Next steps:"
echo "  $(bold 'Local dev:')  cd worker && npm run dev"
echo "  $(bold 'Deploy:')     ./deploy.sh"
echo "  $(bold 'Upload:')     Visit /upload.html and enter your admin token"
if [ -n "$CUSTOM_DOMAIN" ]; then
echo ""
echo "  $(bold 'DNS setup required for') $(yellow "$CUSTOM_DOMAIN")$(bold ':')"
echo "    1. Go to $(yellow 'https://dash.cloudflare.com') → $(yellow "$CUSTOM_DOMAIN") → DNS → Records"
echo "    2. Add record:  Type=$(yellow 'AAAA')  Name=$(yellow '@')  Content=$(yellow '100::')  Proxy=$(yellow 'Proxied')"
echo "    The AAAA record is a placeholder — Cloudflare's proxy intercepts traffic"
echo "    and routes it to your Worker. The address 100:: is never reached."
fi
echo ""
