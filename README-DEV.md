# Developer guide — Bài Nhà (local backend)

This worktree runs a **local-only** Node backend with real accounts. It is not intended for public Internet deployment.

## Requirements

- Node.js **18+**
- No `npm install` (stdlib + static `dist/` only)

## Start the app

```bash
npm start
```

Open [http://127.0.0.1:4173/](http://127.0.0.1:4173/)

Environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `4173` | HTTP port |
| `DATA_DIR` | `.local-data/` (repo root) | JSON, submission images, assignment attachment binaries (gitignored) |
| `SECURE_COOKIE` | off | Set `1` when serving over HTTPS |

## First-time teacher setup

1. Start the server on loopback.
2. If no teacher exists, the UI shows **one-time setup** (username + password). There is **no default password**.
3. Setup is only accepted from `127.0.0.1` while uninitialized. A second teacher cannot be registered afterward.

## Student accounts

1. Sign in as teacher → **Lớp học** → create class/students (as before).
2. **Tài khoản** → pick an existing student → username + temporary password (shown once).
3. Student signs in → must **change password** before any other screen.

## Import old IndexedDB data

Teacher → **Cài đặt** → **Chuyển dữ liệu cũ trên máy này** reads legacy browser IndexedDB (`baiNhaDemoLocal`) and uploads records + photos to the server. Legacy DB is not modified.

Fresh server starts empty (no auto-seed on login).

## Tests

```bash
npm test
```

Uses ephemeral `DATA_DIR` and random ports for HTTP integration tests.

## Assignment attachments (teacher → student)

Teachers can attach up to **10 files** per assignment (**20 MB** each): JPG/JPEG, PNG, WebP, PDF, DOC, DOCX. Files are stored under `DATA_DIR/attachments/` with metadata in `state.json`. Students in the assignment’s class can download linked files; other classes and unauthenticated users cannot. Word documents are **download only** (no in-browser preview). JSON backup/export does **not** include attachment binaries—copy `DATA_DIR` for a full local backup.

## QA / limits (dev)

- No email password recovery
- No multi-teacher SaaS model (single teacher installation)
- CSRF + session cookies; no auth in `localStorage`
- Not hardened for hostile WAN exposure — keep on localhost unless you add TLS, reverse proxy, and ops review

## UX rules (worktree)

- **Thông báo:** Toast xanh chỉ sau khi máy chủ trả thành công (`toastSuccess`); tự ẩn ~4s, có nút đóng, vùng `aria-live="polite"`. Lỗi lưu/network dùng banner đỏ cố định có **Thử lại** khi an toàn. Nháp/lưu tự động **không** toast (chỉ thanh trạng thái header).
- **Mật khẩu tạm:** Hiển thị trong hộp thoại có nút sao chép — không dùng `alert` hay toast. Gửi lại cùng `operationId` không tạo mật khẩu mới; cache replay **không** lưu plaintext credential. Nếu phản hồi reset bị mất sau khi máy chủ đã cấp mật khẩu, banner có **Cấp mật khẩu tạm mới** (xác nhận riêng, `operationId` mới) — khác với **Thử lại** trên lỗi lưu (cùng `operationId` trong một phiên).
- **Tài khoản học sinh:** Mỗi học sinh chỉ một tài khoản **đang hoạt động**; tạo/kích hoạt lại kiểm tra trong transaction có replay.
- **Trùng lặp:** Tên đăng nhập trim + so khớp không phân biệt hoa thường trên server. Cảnh báo (confirm) cho tên lớp/học sinh/bài tập trùng trong cùng lớp — không gộp bản ghi. Tệp đính kèm: fingerprint nội dung (size, lastModified, tên, SHA-256).
- **Thao tác lặp:** Client gửi `operationId` (UUID) trên tạo lớp/học sinh/bài/tài khoản/nộp bài/reset mật khẩu; retry cùng ID + payload → kết quả cũ, payload khác → HTTP 409.
- **Nút bấm:** `withBusyButton` + vô hiệu hóa khi đang gửi cho các mutation chính.

### Giới hạn còn lại

- Chưa có undo API cho xung đột 409 (chỉ thông báo + tải lại).
- Chưa nhân bản bài tập an toàn (không có UI giả).
- `beforeunload` / dirty form: mới có confirm trên đóng dialog; form toàn trang chưa theo dõi dirty đầy đủ.
- Upload assignment dùng `createAttachmentUploadController` (`ux-upload.js`): `waitSettled` chờ mọi job (kể cả hashing) đăng ký đồng bộ; dedupe trùng fingerprint cập nhật busy. Ảnh nộp bài học sinh: chờ job tải ảnh trước lưu nháp/nộp; nút bị khóa khi đang xử lý.
- Thử lại lưu toàn cục (banner/thanh trạng thái) giữ `operationId` chỉ trong cùng phiên đăng nhập (`requestEpoch`); đăng xuất tạo ID mới.
- Grading prev/next trong editor: chưa thêm (hàng đợi vẫn qua `#/grading`).
