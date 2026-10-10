#!/usr/bin/env bash
# Seeds the disposable Noodle started by `docker compose -f e2e/compose.yml up -d`: an admin, a "public" user
# with one photo, a read-only API key for that user and e2e/gateway.yaml. Then run `node src/main.ts e2e/gateway.yaml`
# and open http://gal1.localhost:28080.
set -euo pipefail
API=http://127.0.0.1:22830/api
DIR=$(dirname "$0")
j() { curl -sS -H 'content-type: application/json' "$@"; }

j -X POST $API/auth/admin-sign-up -d '{"email":"admin@example.com","password":"admin","name":"Admin"}' >/dev/null
ADMIN=$(j -X POST $API/auth/login -d '{"email":"admin@example.com","password":"admin"}' | python3 -I -c 'import json,sys;print(json.load(sys.stdin)["accessToken"])')
j -X POST $API/admin/users -H "authorization: Bearer $ADMIN" \
  -d '{"email":"gal1@example.com","password":"gal1pass","name":"Galeria 1","shouldChangePassword":false}' >/dev/null
USER=$(j -X POST $API/auth/login -d '{"email":"gal1@example.com","password":"gal1pass"}' | python3 -I -c 'import json,sys;print(json.load(sys.stdin)["accessToken"])')
j -X PUT $API/users/me/onboarding -H "authorization: Bearer $USER" -d '{"isOnboarded":true}' >/dev/null

magick -size 640x480 gradient:blue-orange "$DIR/photo.jpg"
curl -sS -X POST $API/assets -H "authorization: Bearer $USER" \
  -F assetData=@"$DIR/photo.jpg" -F fileCreatedAt=2026-01-01T00:00:00.000Z -F fileModifiedAt=2026-01-01T00:00:00.000Z \
  -F deviceAssetId=photo-1 -F deviceId=e2e > "$DIR/asset.json"

PERMS='["asset.read","asset.view","asset.statistics","assetFile.read","album.read","album.statistics","person.read","person.statistics","face.read","map.read","map.search","memory.read","memory.statistics","tag.read","stack.read","folder.read","sharedSpace.read","sharedSpaceAsset.read","user.read","userPreference.read","userProfileImage.read","userConfig.read","userOnboarding.read","activity.read","activity.statistics"]'
j -X POST $API/api-keys -H "authorization: Bearer $USER" -d "{\"name\":\"public-gateway\",\"permissions\":$PERMS}" \
  | python3 -I -c 'import json,sys;d=json.load(sys.stdin);print(d.get("secret") or d)' > "$DIR/gal1.key"

cat > "$DIR/gateway.yaml" <<YAML
upstream: http://127.0.0.1:22830
listen: { host: 127.0.0.1, port: 28080 }
galleries:
  - host: gal1.localhost
    apiKeyFile: gal1.key
    title: Galeria 1
    features: { people: true, map: true }
YAML
echo "asset: $(cat "$DIR/asset.json")"
echo "key: $(head -c 8 "$DIR/gal1.key")…"
