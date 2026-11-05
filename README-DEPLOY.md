# Triển khai Bài Nhà

Tài liệu mô tả **cấu hình triển khai** (Render, Docker). Deploy thật do bạn thực hiện — **không coi là đã deploy** chỉ vì có file trong repo.

## Khuyến nghị: Render (Web Service + disk, không cần VPS / domain riêng)

Repo có `render.yaml` (Blueprint). **Không tự deploy** — bạn tạo tài khoản Render, kết nối Git, và **duyệt push** (repo private cần quyền GitHub).

1. Push repo lên GitHub (branch có `Dockerfile`, `render.yaml`) — **chỉ khi bạn yêu cầu commit/push**; worktree hiện có thể chưa có commit.
2. Trên Render: **New → Blueprint**, chọn repo, áp dụng `render.yaml`.
3. Cấu hình env (Dashboard, khớp blueprint):
   - `HOST=0.0.0.0`, `PORT=10000`, `DATA_DIR=/var/lib/bai-nha`, `SECURE_COOKIE=1`
   - `PUBLIC_ORIGIN` = URL HTTPS do Render cấp (vd. `https://<tên-service>.onrender.com`) — **sync: false**, gõ đúng sau khi service được tạo
   - `SETUP_TOKEN` = chuỗi bí mật dài do **bạn** tạo trên Dashboard (không lưu trong repo)
4. **Persistent disk** `bai-data` gắn `/var/lib/bai-nha` (≥1 GB trong blueprint). Tài liệu: [Render Disks](https://render.com/docs/disks), [Blueprint spec](https://render.com/docs/blueprint-spec).
5. `autoDeploy: false` — deploy thủ công sau khi kiểm tra env.
6. Health check: `GET /api/health`.
7. Gói **Starter** (512 MB RAM) thường đủ lớp nhỏ; PDF/import nặng có thể cần tăng memory sau khi quan sát.

### Bootstrap an toàn trên Render (chưa có giáo viên)

Chọn **một** hướng (không chia sẻ URL công khai trước khi xong):

**A — Upload dữ liệu đã khởi tạo (migrate/backup local → disk):** trên máy bạn chạy `migrate-json-to-sqlite.mjs` hoặc `backup-sqlite-data.mjs`, kiểm tra manifest/marker, rồi đưa bundle lên disk **khi app không ghi** (xem mục “Đưa dữ liệu lên disk” bên dưới). Tài khoản giáo viên đã nằm trong SQLite — **không** cần gọi `/api/auth/setup` trên URL public.

**B — Thiết lập qua API trên URL public:** bắt buộc có `SETUP_TOKEN` **và** `PUBLIC_ORIGIN` khớp HTTPS. Gọi `POST /api/auth/setup` tới URL public với header `x-bn-setup-token` (giá trị = env `SETUP_TOKEN`), cookie CSRF (`GET /api/auth/csrf` trước), header `x-bn-csrf`, và `Origin` khớp `PUBLIC_ORIGIN`. Ví dụ (thay URL và dùng token từ Dashboard — **không** dán secret vào repo):

```powershell
$origin = "https://YOUR-SERVICE.onrender.com"
$csrf = (Invoke-WebRequest -Uri "$origin/api/auth/csrf" -SessionVariable s).Content
# Parse csrf từ JSON/cookie session; đặt $token = env SETUP_TOKEN trên Render
Invoke-WebRequest -Uri "$origin/api/auth/setup" -Method POST -WebSession $s `
  -Headers @{ Origin=$origin; "x-bn-csrf"=$csrfCookie; "x-bn-setup-token"=$token } `
  -ContentType "application/json" `
  -Body '{"username":"...","password":"...","displayName":"..."}'
```

UI trình duyệt **chưa** gửi `x-bn-setup-token` — setup thuần UI trên public URL cần token trong env + gọi API như trên (hoặc dùng hướng A).

Khi `PUBLIC_ORIGIN` đã cấu hình mà hệ thống **chưa** `initialized`, server **từ chối** setup nếu thiếu `SETUP_TOKEN`. Khi `SETUP_TOKEN` có, mọi setup (kể cả loopback qua proxy) phải khớp header — tránh bypass qua `remoteAddress` local.

### Quyền ghi disk và user container

Image Docker chạy user **`node`** (uid/gid 1000 có sẵn trong `node:24.16` — **không** tạo user `nodeapp`). Trước production, **bạn** nên xác minh process ghi được `DATA_DIR` (vd. tạo file thử qua Shell/SSH khi service tạm dừng hoặc thư mục con mới — repo **chưa** xác minh build container trong CI).

### Đưa SQLite + blob lên disk Render (offline, không URL public)

**Không** copy đè file SQLite/`images`/`attachments` trong khi process đang ghi cùng thư mục — dễ hỏng DB.

Render **suspend** service khi idle: **Shell Dashboard thường không mở được** khi service đang suspended — **không** dùng quy trình “Stop service → mở Shell” nếu bước Shell thực tế không khả dụng. Cách an toàn hơn:

1. Trên máy local: `node tools/migrate-json-to-sqlite.mjs` hoặc `backup-sqlite-data.mjs` → thư mục có `migration-complete.marker` / `backup-complete.marker` + manifest.
2. Trên disk Render, dùng **thư mục con mới** (vd. `/var/lib/bai-nha/data-v2/`) trong lúc app **không ghi** vào subdir đó (service tạm dừng/suspend, hoặc `DATA_DIR` vẫn trỏ chỗ cũ cho đến khi xong copy).
3. Chuyển bundle bằng **SSH riêng Render** (nếu bạn bật) hoặc upload thủ công theo [Render SSH / disk docs](https://render.com/docs/disks) — **không** dùng link tải công khai không xác thực.
4. Kiểm tra integrity (`backup-manifest.json`, `PRAGMA integrity_check` trong container hoặc local).
5. Đổi env `DATA_DIR` (hoặc subpath) sang thư mục mới **một lần**, restart service, kiểm tra `/api/health` và đăng nhập.
6. Giữ thư mục cũ làm backup read-only; không xóa tự động từ repo.

Không cần mua domain — URL `*.onrender.com` với `PUBLIC_ORIGIN` khớp HTTPS.

## Lưu trữ: SQLite (một writer)

- Mặc định: `DATA_DIR` chứa `app.sqlite` (+ `images/`, `attachments/`).
- **Sau này** nhiều writer hoặc dung lượng rất lớn: cân nhắc PostgreSQL + object storage — chưa có trong bản này.

SQLite là **adapter tương thích JSON**, không schema quan hệ chuẩn hóa đầy đủ: năm bảng (`singletons`, `entity_rows`, `kv_maps`, `state_extensions`, `app_metadata`). Collection nằm trong `entity_rows.payload_json`. View chỉ đọc (vd. `v_classes`, `v_students`) phục vụ truy vấn ad hoc; payload vẫn JSON.

**Ràng buộc:** một process writer / một `DATA_DIR`. Không hai container ghi cùng volume.

## Di trú JSON → SQLite (offline)

1. Dừng server đang ghi (vd. local port 4178 — lead cutover; **không** chạm thư mục live đang chạy nếu chưa dừng).
2. Trên bản copy QA:

```powershell
node tools/migrate-json-to-sqlite.mjs --source "D:\du-lieu-cu" --destination "D:\du-lieu-sqlite-moi"
```

- `--destination` thư mục **trống**, khác source, không symlink, không lồng nhau.
- Tool **không sửa/xóa** source; từ chối symlink trên `images/`/`attachments/` source và trên đường dẫn đích.
- Trước `migration-complete.marker`, tool **đọc lại** `state.json` gốc — nếu hash đổi giữa chừng, từ chối hoàn tất (destination có thể còn partial markers, **không** auto-xóa).
- Khi OK: `migration-complete.marker`, `migration-manifest.json`, backup `migration-source/state.json`.

```powershell
node tools/export-sqlite-state.mjs --source "D:\du-lieu-sqlite-moi" --out snapshot.json
```

3. Cutover: `DATA_DIR` trỏ thư mục mới sau khi lead xác nhận manifest.

Rollback tạm: `STORE_BACKEND=json` nếu vẫn còn `state.json` gốc.

## Sao lưu SQLite

Dừng app:

```powershell
node tools/backup-sqlite-data.mjs --source "D:\data\DATA_DIR" --destination "D:\backup\2026-11-05"
```

Khôi phục: trỏ `DATA_DIR` sang thư mục backup (hoặc copy sang path mới), kiểm tra `backup-manifest.json` + `integrity_check`. Lỗi → có thể có `backup-incomplete.marker`.

Trong container (khi build đã được bạn xác minh), CLI nằm tại `/app/tools/` (image copy `tools/`).

## Docker trên VM (tuỳ chọn — cần domain / TLS)

Yêu cầu: Docker Engine + Compose, tên miền trỏ IP máy.

```powershell
copy .env.example .env
# Sửa DOMAIN và PUBLIC_ORIGIN (HTTPS, khớp nhau)
docker compose build
docker compose up -d
```

**Lưu ý:** repo **chưa** xác minh `docker compose build` trong môi trường hiện tại (Docker daemon có thể không chạy). Sau khi build thành công trên máy bạn, kiểm tra health và quyền ghi volume.

- App: `DATA_DIR=/var/lib/bai-nha`, user **`node`**, Node **24.16** pin trong `Dockerfile`.
- Caddy: TLS, publish 80/443; app không public port trực tiếp.
- `PUBLIC_ORIGIN`: Origin CSRF khớp URL công khai.
- Setup lần đầu: local dev không `PUBLIC_ORIGIN`/`SETUP_TOKEN` — setup từ loopback; production đặt `SETUP_TOKEN` + `PUBLIC_ORIGIN` như mục Render.

## npm scripts

```json
"start": "node server.mjs",
"test": "node --test tests/index.js",
"migrate:json-to-sqlite": "node tools/migrate-json-to-sqlite.mjs",
"backup:sqlite": "node tools/backup-sqlite-data.mjs"
```

```powershell
node tools/migrate-json-to-sqlite.mjs --help
node tools/backup-sqlite-data.mjs --help
node tools/export-sqlite-state.mjs --help
```

## Node

Node **24.16+** với `node:sqlite` (`DatabaseSync`). Kiểm tra:

```powershell
node --version
node -e "import('node:sqlite').then(m=>console.log('sqlite',!!m.DatabaseSync))"
```

## Giới hạn đã biết

- Một writer / một DB file.
- Schema `app_metadata.schemaVersion` — version không hỗ trợ sẽ **từ chối mở**.
- Frontend local có thể hiển thị banner dev.
